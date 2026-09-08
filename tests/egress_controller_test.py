"""Controller trust-boundary and rollback tests; no Docker/root required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('egress_controller', Path(__file__).resolve().parents[1] / 'docker/egress/controller.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_acl_injection_and_overlapping_suffixes(self):
        self.assertEqual(controller.normalize_domains(['*.EXAMPLE.com.', 'example.com', '.sub.example.com', 'a.example.com']), ['.example.com'])
        self.assertEqual(controller.normalize_domains([]), [])
        for bad in ['x\nhttp_access allow all', 'https://example.com/', '127.0.0.1', '2130706433', '[::1]', '0x7f000001', '.', '-bad.com']:
            with self.subTest(bad=bad), self.assertRaises(controller.PolicyError):
                controller.normalize_domains([bad])

    def test_live_admin_authorization_is_rechecked_and_fails_closed(self):
        status = [200]
        calls = []
        class AuthHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.headers.get('Cookie'))
                self.send_response(status[0])
                self.end_headers()
                self.wfile.write(b'{"actorId":"actual-admin"}')
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), AuthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/auth'
            with self.assertRaises(controller.PolicyError) as missing:
                controller.authorize('', url)
            self.assertEqual(missing.exception.status, 401)
            self.assertEqual(calls, [])
            self.assertEqual(controller.authorize('ac_session=browser-token; unrelated=secret', url), 'actual-admin')
            self.assertEqual(calls, ['ac_session=browser-token'])
            status[0] = 403
            with self.assertRaises(controller.PolicyError) as revoked:
                controller.authorize('ac_session=browser-token', url)
            self.assertEqual(revoked.exception.status, 403)
            status[0] = 500
            with self.assertRaises(controller.PolicyError) as failed:
                controller.authorize('ac_session=browser-token', url)
            self.assertEqual(failed.exception.status, 503)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_failed_start_restores_persisted_policy_and_does_not_advance_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = controller.PolicyManager.new_state(['.old.example'], None)
            (root / 'policy.json').write_text(json.dumps(previous))
            with patch.object(controller.PolicyManager, 'validate'), patch.object(controller.PolicyManager, 'start'), patch.object(controller.PolicyManager, 'stop'):
                manager = controller.PolicyManager(root, root / 'runtime')
            with patch.object(manager, 'validate'), patch.object(manager, 'stop'), patch.object(manager, 'start', side_effect=[RuntimeError('failed new start'), None]) as start:
                with self.assertRaises(controller.PolicyError) as failed:
                    manager.update(['.new.example'], previous['revision'], 'admin')
                self.assertEqual(failed.exception.status, 502)
                self.assertEqual(start.call_count, 2)
            self.assertEqual(json.loads((root / 'policy.json').read_text()), previous)
            self.assertEqual((root / 'runtime/blocked-domains.txt').read_text(), '.old.example\n')
            self.assertEqual(manager.state, previous)

    def test_stale_revision_never_replaces_a_newer_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = controller.PolicyManager.new_state(['.old.example'], None)
            (root / 'policy.json').write_text(json.dumps(previous))
            with patch.object(controller.PolicyManager, 'validate'), patch.object(controller.PolicyManager, 'start'), patch.object(controller.PolicyManager, 'stop'), patch.object(controller.PolicyManager, 'ready', return_value=True):
                manager = controller.PolicyManager(root, root / 'runtime')
                applied = manager.update(['.first.example'], previous['revision'], 'admin-one')
                with self.assertRaises(controller.PolicyError) as conflict:
                    manager.update([], previous['revision'], 'admin-two')
                self.assertEqual(conflict.exception.status, 409)
                self.assertEqual(manager.state['revision'], applied['revision'])
                self.assertEqual(json.loads((root / 'policy.json').read_text())['domains'], ['.first.example'])


if __name__ == '__main__':
    unittest.main()
