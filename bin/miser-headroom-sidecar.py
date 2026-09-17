#!/usr/bin/env python3
"""Stateless Miser HTTP adapter; requires cached headroom-ai[ml]==0.37.0."""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import version
STATUS_PATTERN = r'\b(?:WITHHELD|NOT|FAIL|FAILED|FAILURE|SKIP|SKIPPED|DENIED|BLOCKED|REJECTED|ERROR|WARNING|NEVER|WITHOUT|NO)\b'
MAX_BYTES = 1024 * 1024

def build_compressor_factory():
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HEADROOM_KOMPRESS_BACKEND='pytorch', HEADROOM_KOMPRESS_MUST_KEEP='1',
                      HEADROOM_COMPRESSION_DEADLINE_MS='0',
                      HEADROOM_KOMPRESS_CANARY_SECONDS='0', TOKENIZERS_PARALLELISM='false')
    if version('headroom-ai') != '0.37.0':
        raise RuntimeError('Requires headroom-ai==0.37.0')
    import torch
    import headroom.transforms.kompress_compressor as kompress
    torch.set_num_threads(1)
    torch.manual_seed(0)
    # Preserve the entire pinned identifier guard and add status words.
    original = kompress._KOMPRESS_MUST_KEEP_RE
    kompress._KOMPRESS_MUST_KEEP_RE = re.compile(original.pattern + '|(?i:' + STATUS_PATTERN + ')', original.flags)
    compressor = kompress.KompressCompressor(kompress.KompressConfig(
        device=os.environ.get('MISER_HEADROOM_DEVICE', 'cuda'), enable_ccr=False,
        model_id=os.environ.get('MISER_HEADROOM_MODEL', 'chopratejas/kompress-v2-base'), min_input_words=64))
    if not compressor.preload(allow_download=False):
        raise RuntimeError('Provision local model weights before startup')
    # The library caches model/tokenizer weights globally. Only config is shared;
    # request-local failure latches and all other instance state start fresh.
    return lambda: kompress.KompressCompressor(compressor.config)

def handler_for(compressor_factory):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            if self.path != '/v1/compress':
                self.send_error(404)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BYTES:
                    raise ValueError('Invalid body size')
                self.connection.settimeout(5)
                payload = json.loads(self.rfile.read(length))
                if set(payload) != {'text', 'target_ratio'} or not isinstance(payload['text'], str):
                    raise ValueError('Expected text and target_ratio only')
                ratio = payload['target_ratio']
                if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not 0 < ratio <= 1:
                    raise ValueError('Invalid ratio')
            except (ValueError, TypeError, OSError):
                self.send_error(400)
                return
            try:
                result = compressor_factory().compress(payload['text'], target_ratio=ratio, allow_download=False)
                body = json.dumps({'compressed': result.compressed}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_error(503, 'Compression unavailable')
    return Handler

if __name__ == '__main__':
    # Single inference at a time; weights reused, no per-session state or CCR.
    HTTPServer(('127.0.0.1', int(os.environ.get('MISER_HEADROOM_PORT', '20129'))),
               handler_for(build_compressor_factory())).serve_forever()
