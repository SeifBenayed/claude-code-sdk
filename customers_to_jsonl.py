import csv
import json
from datetime import datetime
from pathlib import Path

input_path = Path('/Users/seifbenayed/claude-tool-loop/customers.csv')
output_path = Path('/Users/seifbenayed/claude-tool-loop/customers.jsonl')

seen_customer_ids = set()
rows = []

with input_path.open(newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    expected_fields = ['customer_id', 'name', 'email', 'signup_date']
    if reader.fieldnames != expected_fields:
        raise ValueError(f'Unexpected columns: {reader.fieldnames}')

    for line_number, row in enumerate(reader, start=2):
        cleaned = {}
        for field in expected_fields:
            value = row[field]
            cleaned[field] = value.strip() if isinstance(value, str) else value

        cleaned['email'] = cleaned['email'].lower()

        customer_id = cleaned['customer_id']
        if customer_id in seen_customer_ids:
            raise ValueError(f'Duplicate customer_id on line {line_number}: {customer_id}')
        seen_customer_ids.add(customer_id)

        email = cleaned['email']
        if email.count('@') != 1:
            raise ValueError(f'Invalid email on line {line_number}: {email}')

        signup_date = cleaned['signup_date']
        try:
            cleaned['signup_date'] = datetime.strptime(signup_date, '%Y-%m-%d').date().isoformat()
        except ValueError as exc:
            raise ValueError(f'Invalid signup_date on line {line_number}: {signup_date}') from exc

        rows.append(cleaned)

with output_path.open('w', encoding='utf-8', newline='') as f:
    for row in rows:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
