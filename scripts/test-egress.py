#!/usr/bin/env python3
"""Isolated, offline network tests. Requires prebuilt egress images and rootful Docker.

python3 scripts/test-egress.py --app-image noah-egress-app-test \
    --proxy-image noah-egress-proxy-test
Only randomly named test containers/network are removed; no deployment is touched.
"""
import argparse
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runtime", choices=["docker", "nerdctl"], default="docker")
parser.add_argument("--app-image", default="noah-almighty:egress")
parser.add_argument("--proxy-image", default="noah-almighty-egress-proxy:local")
args = parser.parse_args()
prefix = "noah-egress-test-" + uuid.uuid4().hex[:10]
containers = []


def run(*command, check=True):
    result = subprocess.run([args.runtime, *command], text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stderr}\n{result.stdout}")
    return result


def start(suffix, *command):
    name = prefix + "-" + suffix
    containers.append(name)
    run("run", "-d", "--name", name, "--network", prefix, *command)
    return name


caps = ["--cap-drop=ALL", "--cap-add=NET_ADMIN", "--cap-add=SETUID",
        "--cap-add=SETGID", "--cap-add=SETPCAP", "--security-opt=no-new-privileges:true"]
fixture_code = """
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
import socket
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/admin-authorize':
            allowed = self.headers.get('Cookie') == 'ac_session=admin-session'
            self.send_response(200 if allowed else 403)
            self.end_headers()
            self.wfile.write(b'{"actorId":"fixture-admin"}' if allowed else b'{}')
            return
        self.send_response(302 if self.path == '/redirect' else 200)
        if self.path == '/redirect': self.send_header('Location', 'http://blocked.example/')
        self.end_headers()
        self.wfile.write(b'egress-fixture')
    def log_message(self, *args): pass
for port in (80, 443):
    Thread(target=HTTPServer(('0.0.0.0', port), Handler).serve_forever, daemon=True).start()
class V6Server(HTTPServer): address_family = socket.AF_INET6
V6Server(('::', 8080), Handler).serve_forever()
"""
checks = r'''
import http.client, os, socket, subprocess, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
proxy = os.environ['NOAH_EGRESS_PROXY_IP']
target = os.environ['TEST_TARGET_IP']
target6 = os.environ['TEST_TARGET_IPV6']
def request(url, method='GET'):
    conn = http.client.HTTPConnection(proxy, 3128, timeout=4)
    conn.request(method, url)
    res = conn.getresponse()
    status = res.status
    conn.close()
    return status
def denied_connection(host, port, family=socket.AF_INET):
    with socket.socket(family) as s:
        s.settimeout(.6)
        try: s.connect((host, port))
        except OSError: return
        raise AssertionError(f'direct connection succeeded: {host}:{port}')
assert os.getuid() == 1000
assert os.environ['HOME'] == '/home/node'
status = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
for key in ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb'):
    assert int(status[key].strip(), 16) == 0, (key, status[key])
assert status['NoNewPrivs'].strip() == '1'
assert subprocess.run(['iptables', '-F'], capture_output=True).returncode != 0
assert request('http://allowed.example/') == 200
for host in ('blocked.example', 'sub.blocked.example', 'BLOCKED.EXAMPLE', 'blocked.example.'):
    assert request('http://' + host + '/') == 403, host
    assert request(host + ':443', 'CONNECT') == 403, host
for host in (target, '2130706433', '0x7f000001', '[::1]'):
    assert request('http://' + host + '/') == 403, host
assert request('allowed.example:22', 'CONNECT') == 403
conn = http.client.HTTPConnection(proxy, 3128, timeout=4)
conn.set_tunnel('allowed.example', 443)
conn.request('GET', '/')
assert conn.getresponse().status == 200  # CONNECT tunnel transports bytes
conn.close()
for port in (80, 443, 22): denied_connection(target, port)
denied_connection(target6, 8080, socket.AF_INET6)
denied_connection('127.0.0.11', 53)  # Docker's embedded resolver
denied_connection('1.1.1.1', 53)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(.6)
    # A valid DNS query must not get a reply from the embedded resolver.
    try:
        s.sendto(bytes.fromhex('123401000001000000000000') + b'\x07example\x03com\0\0\x01\0\x01', ('127.0.0.11', 53))
        data = s.recv(512)
    except OSError: pass
    else: raise AssertionError('DNS bypass returned a response: ' + repr(data))
assert subprocess.check_output(['curl', '-sS', '--max-time', '4', 'http://allowed.example/']).strip() == b'egress-fixture'
assert subprocess.run(['curl', '-fsSL', '--max-time', '4', 'http://allowed.example/redirect'], capture_output=True).returncode != 0
assert subprocess.run(['curl', '--noproxy', '*', '--max-time', '1', 'http://' + target], capture_output=True).returncode != 0
assert subprocess.check_output(['node', '-e', "fetch('http://allowed.example/').then(r=>r.text()).then(console.log)"]).strip() == b'egress-fixture'
class Handler(BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers()
    def log_message(self, *args): pass
server = HTTPServer(('127.0.0.1', 18888), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
assert subprocess.run(['curl', '-fsS', '--noproxy', '*', 'http://127.0.0.1:18888'], capture_output=True).returncode == 0
print('PASS: domain/CONNECT/IP/redirect/DNS/IPv4/IPv6 rules, curl, Node fetch, loopback, privilege drop', flush=True)
'''

policy_checks = r'''
import http.client, json, socket
def policy(method='GET', body=None, cookie='ac_session=admin-session'):
    conn = http.client.HTTPConnection('172.30.246.2', 3129, timeout=15)
    conn.request(method, '/policy', json.dumps(body) if body is not None else None,
                 {'Cookie': cookie, 'Content-Type': 'application/json'})
    response = conn.getresponse()
    result = (response.status, json.loads(response.read()))
    conn.close()
    return result
def fetch():
    conn = http.client.HTTPConnection('172.30.246.2', 3128, timeout=4)
    conn.request('GET', 'http://allowed.example/')
    response = conn.getresponse()
    code = response.status
    response.read()
    conn.close()
    return code
assert policy(cookie='')[0] == 401
assert policy(cookie='ac_session=member-session')[0] == 403
status, original = policy()
assert status == 200 and original['proxyReady']
assert policy('PUT', {'domains': [], 'revision': original['revision']}, cookie='ac_session=member-session')[0] == 403
assert policy('PUT', {'domains': ['bad\nhttp_access allow all'], 'revision': original['revision']})[0] == 400
assert policy()[1]['revision'] == original['revision']
# Hold an idle CONNECT tunnel open while the policy is applied.
tunnel = socket.create_connection(('172.30.246.2', 3128), timeout=4)
tunnel.sendall(b'CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n')
assert b'200' in tunnel.recv(4096)
status, applied = policy('PUT', {'domains': ['.allowed.example', 'api.allowed.example'], 'revision': original['revision']})
assert status == 200 and applied['domains'] == ['.allowed.example'] and applied['appliedBy'] == 'fixture-admin'
assert fetch() == 403
assert tunnel.recv(4096) == b'', 'Old CONNECT tunnel survived policy apply'
tunnel.close()
assert policy('PUT', {'domains': [], 'revision': original['revision']})[0] == 409
status, cleared = policy('PUT', {'domains': [], 'revision': applied['revision']})
assert status == 200 and cleared['domains'] == [] and fetch() == 200
print('PASS: independent admin authorization, apply, tunnel closure, conflict, clear and live traffic', flush=True)
'''

try:
    run("network", "create", "--ipv6", "--subnet", "172.30.246.0/24",
        "--subnet", "fd00:30:246::/64", prefix)
    fixture = start("fixture", "--ip", "172.30.246.3", "--ip6", "fd00:30:246::3",
                    "--entrypoint", "python3", args.app_image, "-c", fixture_code)
    proxy = start("proxy", "--ip", "172.30.246.2", "--read-only", "--cap-drop=ALL",
                  "--security-opt=no-new-privileges:true", "--tmpfs", "/run", "--tmpfs", "/tmp",
                  "--tmpfs", "/var/spool/squid", "--add-host", "allowed.example:172.30.246.3",
                  "--add-host", "blocked.example:172.30.246.3",
                  "--mount", f"type=volume,source={prefix}-policy,target=/var/lib/noah-egress",
                  "-e", "NOAH_EGRESS_AUTH_URL=http://172.30.246.3/admin-authorize", args.proxy_image)
    # Wait for a real proxy response instead of depending on container startup order.
    ready = "import socket; socket.create_connection(('172.30.246.2',3128),1).close()"
    for _ in range(30):
        if run("exec", fixture, "python3", "-c", ready, check=False).returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError("Proxy not ready: " + run("logs", proxy, check=False).stderr)
    app = start("checks", *caps, "-e", "NOAH_EGRESS_PROXY_IP=172.30.246.2",
                "-e", "TEST_TARGET_IP=172.30.246.3", "-e", "TEST_TARGET_IPV6=fd00:30:246::3",
                args.app_image, "python3", "-c", checks)
    assert run("wait", app).stdout.strip() == "0", run("logs", app, check=False)
    print(run("logs", app).stdout.strip())
    run("start", app)
    assert run("wait", app).stdout.strip() == "0", "Rules failed after restart"
    print("PASS: container restart reapplies policy")
    server = start("server", *caps, "--ip", "172.30.246.4",
                   "-e", "NOAH_EGRESS_PROXY_IP=172.30.246.2",
                   "-e", "SESSION_SECRET=isolated-egress-smoke-test-only", args.app_image)
    health = "import urllib.request; assert urllib.request.urlopen('http://172.30.246.4:48787/api/bootstrap', timeout=1).status == 200"
    for _ in range(40):
        if run("exec", fixture, "python3", "-c", health, check=False).returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Noah failed to boot: " + run("logs", server, check=False).stderr)
    print("PASS: Noah starts and answers incoming app/health requests")
    print(run("exec", fixture, "python3", "-c", policy_checks).stdout.strip())
    run("restart", proxy)
    # Persistent state must override the seed on every restart.
    persisted = "import http.client,json; c=http.client.HTTPConnection('172.30.246.2',3129,timeout=1); c.request('GET','/policy',headers={'Cookie':'ac_session=admin-session'}); r=c.getresponse(); assert r.status==200 and json.loads(r.read())['domains']==[]"
    for _ in range(30):
        if run("exec", fixture, "python3", "-c", persisted, check=False).returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError("Applied policy did not persist after restart")
    print("PASS: applied policy persists across controller restart")
    run("stop", "-t", "1", proxy)
    offline = run("run", "--rm", "--network", prefix, *caps,
                  "-e", "NOAH_EGRESS_PROXY_IP=172.30.246.2", args.app_image,
                  "curl", "-fsS", "--max-time", "2", "http://allowed.example/", check=False)
    assert offline.returncode != 0, "Proxy outage must fail closed"
    no_caps = run("run", "--rm", "--network", prefix, "--cap-drop=ALL",
                  args.app_image, "echo", "APPLICATION_STARTED", check=False)
    assert no_caps.returncode != 0 and "APPLICATION_STARTED" not in no_caps.stdout
    print("PASS: proxy outage and missing NET_ADMIN fail closed")
finally:
    for name in reversed(containers):
        run("rm", "-f", name, check=False)
    run("network", "rm", prefix, check=False)
    run("volume", "rm", prefix + "-policy", check=False)
