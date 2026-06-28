#!/usr/bin/env bash
export GH_TOKEN='***'
# Test GitHub API access
echo "=== Testing repo access ==="
curl -s -H "Authorization: Bearer *** https://api.github.com/repos/reedonee/ORCH | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Repo:', d.get('full_name', 'N/A'))
print('Private:', d.get('private', 'N/A'))
print('Message:', d.get('message', 'OK'))
"
echo "=== Testing user ==="
curl -s -H "Authorization: Bearer *** https://api.github.com/user | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Login:', d.get('login', 'N/A'))
print('Message:', d.get('message', 'OK'))
"
