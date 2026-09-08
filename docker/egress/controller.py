"""Own Squid and its policy outside the avatar container.

Every read/write checks the caller's browser session against Noah's live admin
gate. No long-lived controller credential is placed in the avatar environment.
"""
import http.cookies
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class PolicyError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def normalize_domains(values):
    if not isinstance(values, list) or len(values) > 500:
        raise PolicyError(400, "도메인은 최대 500개까지 등록할 수 있습니다.")
    result = set()
    for value in values:
        if not isinstance(value, str):
            raise PolicyError(400, "도메인 형식이 올바르지 않습니다.")
        value = value.strip().lower().rstrip('.')
        if value.startswith('*.'):
            value = value[1:]
        host = value.removeprefix('.')
        if (not host or len(host) > 253 or not host.isascii()
                or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                       for label in host.split('.'))
                or re.fullmatch(r'[0-9.]+', host) or host.startswith('0x')):
            raise PolicyError(400, "URL·IP 대신 도메인을 입력하세요. 예: .example.com")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            result.add(value)
        else:
            raise PolicyError(400, "IP 주소는 도메인 목록에 등록할 수 없습니다.")
    # Squid rejects overlapping entries in the same dstdomain ACL. A parent
    # suffix already covers both the apex and descendants; keep only that rule.
    return sorted(value for value in result if not any(
        other.startswith('.') and other != value
        and (value.lstrip('.') == other[1:] or value.lstrip('.').endswith(other))
        for other in result
    ))


def atomic_write(path, contents):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        output.write(contents)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class PolicyManager:
    def __init__(self, state_dir=Path('/var/lib/noah-egress'), runtime_dir=Path('/tmp/noah-egress'), check_only=False):
        self.lock = threading.RLock()
        self.process = None
        self.state_file = state_dir / 'policy.json'
        self.runtime_dir = runtime_dir
        runtime_dir.mkdir(parents=True, exist_ok=True)
        state_dir.mkdir(parents=True, exist_ok=True)
        if self.state_file.exists():
            self.state = json.loads(self.state_file.read_text())
            self.state['domains'] = normalize_domains(self.state['domains'])
        else:
            seed = Path('/etc/noah-egress/blocked-domains.txt').read_text().splitlines()
            domains = normalize_domains([line.split('#', 1)[0].strip() for line in seed
                                         if line.split('#', 1)[0].strip()])
            self.state = self.new_state(domains, None)
            if not check_only:
                self.persist(self.state)
        self.render(self.state['domains'])
        self.validate()
        if not check_only:
            self.start()

    @staticmethod
    def new_state(domains, actor):
        return dict(domains=domains, revision=uuid.uuid4().hex,
                    appliedAt=datetime.now(timezone.utc).isoformat(), appliedBy=actor)

    def persist(self, state):
        atomic_write(self.state_file, json.dumps(state, ensure_ascii=False))

    def render(self, domains):
        # Squid requires a nonempty ACL; .invalid is reserved and never resolves.
        atomic_write(self.runtime_dir / 'blocked-domains.txt', '\n'.join(domains or ['.blocked.invalid']) + '\n')

    def validate(self):
        result = subprocess.run(['squid', '-k', 'parse', '-f', '/etc/squid/squid.conf'],
                                capture_output=True, timeout=10)
        if result.returncode:
            # Squid parse output can include corporate-parent credentials.
            raise PolicyError(502, "프록시 설정 검사에 실패했습니다. 운영 설정을 확인하세요.")

    def ready(self):
        if self.process is None or self.process.poll() is not None:
            return False
        try:
            with socket.create_connection(('127.0.0.1', 3128), timeout=.2):
                return True
        except OSError:
            return False

    def start(self):
        self.process = subprocess.Popen(['squid', '-N', '-f', '/etc/squid/squid.conf'], start_new_session=True)
        for _ in range(50):
            if self.ready():
                return
            if self.process.poll() is not None:
                break
            time.sleep(.1)
        self.stop()
        raise PolicyError(502, "프록시를 시작하지 못했습니다. 적용 상태를 다시 확인하세요.")

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)

    def snapshot(self):
        with self.lock:
            return dict(self.state, proxyReady=self.ready())

    def update(self, domains, revision, actor):
        domains = normalize_domains(domains)
        with self.lock:
            if revision != self.state['revision']:
                raise PolicyError(409, "다른 관리자가 목록을 변경했습니다. 최신 목록을 불러온 후 다시 적용하세요.")
            if domains == self.state['domains'] and self.ready():
                return self.snapshot()
            previous = self.state
            candidate = self.new_state(domains, actor)
            try:
                self.render(domains)
                self.validate()
                # Stop closes ALL old CONNECT tunnels before starting new policy.
                self.stop()
                self.persist(candidate)
                self.start()
                self.state = candidate
            except Exception:
                self.stop()
                self.persist(previous)
                self.render(previous['domains'])
                self.start()
                raise PolicyError(502, "적용에 실패해 이전 정책으로 복구했습니다. 현재 상태를 새로고침하세요.")
            return self.snapshot()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def authorize(cookie_header, auth_url):
    try:
        cookie = http.cookies.SimpleCookie(cookie_header or '')
        token = cookie['ac_session'].value
        if not token or len(token) > 1024:
            raise ValueError()
    except (KeyError, ValueError, http.cookies.CookieError):
        raise PolicyError(401, "관리자 로그인이 필요합니다.")
    request = urllib.request.Request(auth_url, headers={
        'Cookie': 'ac_session=' + urllib.parse.quote(token, safe=''),
    })
    # Fixed operator-configured destination, no proxy and no redirects. Never
    # accept an authorization URL, actor id or machine key from the caller.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=5) as response:
            body = json.loads(response.read(4096))
            if response.status != 200 or not isinstance(body.get('actorId'), str) or not body['actorId']:
                raise ValueError()
            return body['actorId']
    except urllib.error.HTTPError as error:
        error.close()
        if error.code in (401, 403):
            raise PolicyError(error.code, "유효한 관리자 세션이 필요합니다.")
        raise PolicyError(503, "관리자 권한을 확인할 수 없습니다.")
    except (OSError, ValueError):
        raise PolicyError(503, "관리자 권한을 확인할 수 없습니다.")


def handler_for(manager, auth_url):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log session cookies or request bodies.

        def reply(self, status, body):
            encoded = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def handle_policy(self, write=False):
            try:
                if self.path != '/policy':
                    raise PolicyError(404, "지원하지 않는 경로입니다.")
                actor = authorize(self.headers.get('Cookie'), auth_url)
                if not write:
                    return self.reply(200, manager.snapshot())
                if self.headers.get_content_type() != 'application/json':
                    raise PolicyError(415, "JSON 요청만 지원합니다.")
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 150000:
                    raise PolicyError(413, "요청 크기가 너무 크거나 본문이 없습니다.")
                self.connection.settimeout(5)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
                return self.reply(200, manager.update(body.get('domains'), body.get('revision'), actor))
            except PolicyError as error:
                self.reply(error.status, {'error': error.message})
            except (ValueError, TimeoutError):
                self.reply(400, {'error': '요청 형식이 올바르지 않습니다.'})
            except Exception:
                self.reply(503, {'error': '정책 서비스에 오류가 발생했습니다. 현재 적용 상태를 확인하세요.'})

        def do_GET(self):
            self.handle_policy()

        def do_PUT(self):
            self.handle_policy(True)
    return Handler


def main():
    if sys.argv[1:] == ['--check']:
        PolicyManager(check_only=True)
        return
    auth_url = os.environ['NOAH_EGRESS_AUTH_URL']
    parsed = urllib.parse.urlsplit(auth_url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('NOAH_EGRESS_AUTH_URL must be an operator-controlled HTTP(S) URL')
    manager = PolicyManager()
    server = ThreadingHTTPServer(('0.0.0.0', 3129), handler_for(manager, auth_url))
    def shutdown(*_args):
        manager.stop()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever()
    finally:
        manager.stop()
        server.server_close()


if __name__ == '__main__':
    main()
