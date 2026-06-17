#!/usr/bin/env python3
import json
import sys

# Test curl_cffi availability
try:
    from curl_cffi import requests
    print("curl_cffi import OK")
except ImportError as e:
    print(f"curl_cffi import FAILED: {e}")
    sys.exit(1)

# Simulate minimal worker input
data = {
    "mode": "quota",
    "cookies": {"caz": "test"},
}
json.dump(data, sys.stdout)