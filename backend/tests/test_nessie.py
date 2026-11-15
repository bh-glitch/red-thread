"""Validate the boundary to an unavailable external service without faking provenance in the shipped cache."""
import json
from pathlib import Path
import httpx
import pytest
from backend.scripts import seed_nessie


@pytest.fixture
def cache(tmp_path, monkeypatch):
    (tmp_path / 'data').mkdir()
    fixture = Path(__file__).parents[1] / 'data/nessie_cache.json'
    path = tmp_path / 'data/nessie_cache.json'
    path.write_text(fixture.read_text())
    monkeypatch.setattr(seed_nessie, 'ROOT', tmp_path)
    monkeypatch.setenv('NESSIE_API_KEY', 'unit-test-key')
    return path


def test_successful_seed_reads_back_real_service_ids(cache, monkeypatch):
    original_client = httpx.Client
    rows = []
    def handler(request):
        assert request.url.params['key'] == 'unit-test-key'
        if request.method == 'GET':
            return httpx.Response(200, json=rows)
        if request.url.path.endswith('/purchases'):
            body = json.loads(request.content)
            assert body['merchant_id'] == 'service-merchants'
            row = {**body, '_id': f'service-transaction-{len(rows)}'}
            rows.append(row)
            return httpx.Response(201, json={'objectCreated': {'_id': row['_id']}})
        return httpx.Response(201, json={'objectCreated': {'_id': f'service-{request.url.path.split("/")[-1]}'}})
    monkeypatch.setattr(seed_nessie.httpx, 'Client', lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(handler)))
    seed_nessie.seed()
    result = json.loads(cache.read_text())
    assert result['provenance'] == 'nessie'
    assert len(result['transactions']) == 3
    assert all(row['id'].startswith('service-transaction-') for row in result['transactions'])
    assert sum(row['amount'] for row in result['transactions']) == 48750
    assert all(row['display_time'] == '11:52 PM' for row in result['transactions'])
    with pytest.raises(SystemExit, match='already exists'):
        seed_nessie.seed()


def test_upstream_failure_preserves_original_cache(cache, monkeypatch):
    original = cache.read_bytes()
    original_client = httpx.Client
    monkeypatch.setattr(seed_nessie.httpx, 'Client', lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(lambda _: httpx.Response(503, json={'error': 'offline'}))))
    with pytest.raises(httpx.HTTPStatusError):
        seed_nessie.seed()
    assert cache.read_bytes() == original


def test_missing_key_never_writes_cache(cache, monkeypatch):
    monkeypatch.delenv('NESSIE_API_KEY')
    original = cache.read_bytes()
    with pytest.raises(SystemExit, match='Set NESSIE_API_KEY'):
        seed_nessie.seed()
    assert cache.read_bytes() == original
