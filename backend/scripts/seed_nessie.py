"""Run: .venv/bin/python -m backend.scripts.seed_nessie

The cache is replaced only after every API write and readback succeeds. Nessie
supports purchase dates, not time-of-day: display_time is authored case metadata.
"""
import json
import os
from pathlib import Path
import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT.parent / '.env')


def seed():
    key = os.getenv('NESSIE_API_KEY')
    if not key:
        raise SystemExit('Set NESSIE_API_KEY in .env before seeding. Existing fixture cache is unchanged.')
    base = os.getenv('NESSIE_BASE_URL', 'http://api.nessieisreal.com')
    cache = json.loads((ROOT / 'data/nessie_cache.json').read_text())
    if cache['provenance'] == 'nessie':
        raise SystemExit('A Nessie seed already exists. Cache preserved to avoid duplicate bank records.')
    with httpx.Client(base_url=base, params={'key': key}, timeout=12) as client:
        def post(path, body):
            response = client.post(path, json=body)
            response.raise_for_status()
            return response.json()['objectCreated']['_id']
        customer = post('/customers', {'first_name': 'Bluefin', 'last_name': 'Bakery', 'address': {'street_number': '18', 'street_name': 'Witherspoon St', 'city': 'Princeton', 'state': 'NJ', 'zip': '08542'}})
        account = post(f'/customers/{customer}/accounts', {'type': 'Checking', 'nickname': 'Bluefin operating account', 'rewards': 0, 'balance': 150000})
        merchant = post('/merchants', {'name': 'Northshore Supply', 'category': ['Wholesale'], 'address': {'street_number': '400', 'street_name': 'Harbor Road', 'city': 'Newark', 'state': 'NJ', 'zip': '07102'}, 'geocode': {'lat': 40.7357, 'lng': -74.1724}})
        ids = []
        for day in [3, 4, 5]:
            ids.append(post(f'/accounts/{account}/purchases', {'merchant_id': merchant, 'medium': 'balance', 'purchase_date': f'2026-03-0{day}', 'amount': 16250, 'status': 'completed', 'description': 'Northshore invoice payment — case 001'}))
        response = client.get(f'/accounts/{account}/purchases')
        response.raise_for_status()
        rows = {row['_id']: row for row in response.json()}
        if not all(tid in rows for tid in ids):
            raise RuntimeError('Nessie readback did not include all seeded payments; cache unchanged.')
        transactions = [{'id': tid, 'date': rows[tid]['purchase_date'], 'display_time': '11:52 PM', 'merchant': 'Northshore Supply', 'amount': rows[tid]['amount'], 'status': rows[tid]['status']} for tid in ids]
        data = {'provenance': 'nessie', 'notice': 'Nessie API transaction IDs and amounts. Times are authored case metadata; Nessie stores dates only.', 'business': {'name': 'Bluefin Bakery', 'customer_id': customer, 'account_id': account}, 'merchant': {'name': 'Northshore Supply', 'id': merchant}, 'transactions': transactions}
        temp = ROOT / 'data/nessie_cache.tmp'
        temp.write_text(json.dumps(data, indent=2) + '\n')
        temp.replace(ROOT / 'data/nessie_cache.json')
        print('Seeded and read back three Nessie purchases. Cache ready.')


if __name__ == '__main__':
    try:
        seed()
    except httpx.HTTPError:
        raise SystemExit('Nessie is unavailable or rejected a request. Existing cache is unchanged. Check your API key and Nessie service status; do not blindly repeat partial seeds.')
