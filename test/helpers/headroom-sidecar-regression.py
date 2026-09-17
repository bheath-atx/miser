"""Exercise real HTTP handler against a compressor with a permanent failure latch."""
import importlib.util
import json
from pathlib import Path
from http.server import HTTPServer
from threading import Thread
from types import SimpleNamespace
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('sidecar', Path(__file__).resolve().parents[2] / 'bin/miser-headroom-sidecar.py')
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)
instances = []
attempts = []

class Compressor:
    def __init__(self):
        self.failures = 0
        self.degraded = False
        instances.append(self)

    def compress(self, text, **kwargs):
        if self.degraded:
            return SimpleNamespace(compressed=text)
        attempts.append(text)
        if text == 'failure':
            self.failures += 1
            self.degraded = self.failures >= 3
            return SimpleNamespace(compressed=text)
        return SimpleNamespace(compressed='summary')

server = HTTPServer(('127.0.0.1', 0), sidecar.handler_for(Compressor))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    for text in ['failure'] * 3 + ['healthy block', 'healthy block']:
        request = Request(f'http://127.0.0.1:{server.server_port}/v1/compress',
                          data=json.dumps({'text': text, 'target_ratio': 0.5}).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            result = json.load(response)['compressed']
        assert result == (text if text == 'failure' else 'summary'), result
    assert len(instances) == len(attempts) == 5
    assert all(instance.failures <= 1 for instance in instances)
    print('PASS: three failed HTTP blocks followed by two healthy blocks; five isolated instances')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
