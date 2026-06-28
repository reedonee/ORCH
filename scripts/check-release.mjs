import https from 'https';

const token = process.env.GH_TOKEN;
if (!token) { console.log('GH_TOKEN not set'); process.exit(1); }

const opts = {
  hostname: 'api.github.com',
  path: '/repos/reedonee/ORCH/releases',
  headers: {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'node',
  },
};

https.get(opts, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    const releases = JSON.parse(data);
    if (Array.isArray(releases)) {
      console.log('Releases found:', releases.length);
      for (const r of releases) {
        console.log(`  Tag: ${r.tag_name} | Name: ${r.name} | Assets: ${r.assets.length}`);
        for (const a of r.assets) {
          console.log(`    - ${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
    } else {
      console.log('API error:', releases.message);
    }
  });
}).on('error', (e) => console.log('Error:', e.message));
