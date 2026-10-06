import asyncio
import json
import os
import pathlib
import sys

from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/v2/scrape' and body['url'] == 'https://example.com'
        response = json.dumps({'success': True, 'data': {
            'markdown': 'Example Domain content',
            'html': '<p>Example Domain content</p>',
            'metadata': {'title': 'Example Domain', 'sourceURL': body['url']},
        }}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_):
        pass

server = HTTPServer(('127.0.0.1', 0), Handler)
Thread(target=server.serve_forever, daemon=True).start()
os.environ['FIRECRAWL_API_URL'] = f'http://127.0.0.1:{server.server_port}'

sys.path.insert(0, '/opt/hermes')
from importlib.metadata import version
import tomllib
import kubernetes
from tools.environments.kubernetes import STARTER_SESSION_OBJECT

stamp = json.loads(pathlib.Path('/opt/hermes/install-stamp.json').read_text())
provenance = json.loads(pathlib.Path('/etc/hermes/image-provenance.json').read_text())
assert stamp['commit'] == provenance['revision'] == os.environ['EXPECTED_REVISION']
assert stamp['branch'] == 'feat/kubernetes-terminal-backend'
assert stamp['updateMechanism'] == 'external'
assert provenance['image'] == 'ghcr.io/igou-io/hermes-agent-k8s'
assert STARTER_SESSION_OBJECT
lock = tomllib.loads(pathlib.Path('/opt/hermes/uv.lock').read_text())
locked = {p['name']: p['version'] for p in lock['package'] if 'version' in p}
for name in ('firecrawl-py', 'kubernetes'):
    assert version(name) == locked[name], name
print('PASS: pinned fork provenance, Kubernetes backend, locked SDK versions')
root = pathlib.Path(os.environ['HERMES_HOME'])
root.mkdir(parents=True, exist_ok=True)
(root / 'config.yaml').write_text('''security:
  allow_lazy_installs: false
plugins:
  enabled:
    - web-firecrawl
web:
  search_backend: searxng
  extract_backend: firecrawl
  keyless_fallback: false
  use_gateway: false
''')

from tools import web_tools
from agent.web_search_registry import get_provider

web_tools._ensure_web_plugins_loaded()
assert get_provider('firecrawl') is not None
assert web_tools._get_search_backend() == 'searxng'
assert web_tools._get_extract_backend() == 'firecrawl'
result = json.loads(asyncio.run(web_tools.web_extract_tool(['https://example.com'])))
pages = result.get('results', [])
assert pages and pages[0].get('title') == 'Example Domain' and pages[0].get('content') and not pages[0].get('error'), result
print('PASS: Firecrawl SDK extraction against HTTP fixture, plugin discovery, separate search/extract backends, lazy installs disabled')
