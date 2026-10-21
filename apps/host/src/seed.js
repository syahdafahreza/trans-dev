import fs from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from './config.js';

const config = loadConfig();
const root = config.root;
const assets = path.join(config.packageRoot, 'demo-assets');

const TEXT_FILES = {
  'Documents/Product brief.md': `# TransDev — product brief

**Goal:** move a file from a phone to a laptop without a cable, an account, or a cloud upload.

## How it works
1. The phone opens a tiny HTTP server on the local Wi-Fi network.
2. The laptop opens \`http://<phone-ip>:8787\` and pairs with a 4-digit PIN or QR code.
3. The dashboard talks straight to the phone — bytes never leave the network.

## Principles
- **Local only.** No relay, no telemetry, no third-party servers.
- **Explicit consent.** Every session is listed on the phone and can be revoked instantly.
- **Stream everything.** Uploads and downloads are chunked, so a 4 GB video never
  has to fit in memory.
`,
  'Documents/Meeting notes.md': `# Weekly sync — 2026-10-20

- [x] Streaming upload endpoint (chunked, resumable)
- [x] Range requests for video previews
- [ ] Photo library import on iOS (needs Photos framework bridge)
- [ ] Background-safe server life cycle
- [ ] Transfer history + retry

**Decision:** keep the pairing relay optional. PIN pairing is the default because it
works with zero infrastructure.
`,
  'Documents/Q3 budget.csv': `category,planned,actual,delta
Hosting,120,0,-120
Design,900,640,-260
Testing devices,1500,1490,-10
App store fees,99,99,0
`,
  'Inbox/Welcome.txt': `Welcome to TransDev.

Drop files here from your laptop — they land in the phone's Inbox folder.
`,
  'Inbox/README.txt': `This folder is the default destination for uploads from paired devices.
`,
  'Documents/LICENSE.txt': `MIT License

Copyright (c) 2026 TransDev contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
`,
};

const IMAGES = [
  ['demo-1.jpg', 'Photos/Coastline at golden hour.jpg'],
  ['demo-2.jpg', 'Photos/Night market.jpg'],
  ['demo-3.jpg', 'Photos/Desk setup.jpg'],
  ['demo-4.jpg', 'Downloads/Screensaver.jpg'],
];

/** Writes a small, valid single-page PDF so document previews have something to show. */
function minimalPdf(title, body) {
  const lines = body.split('\n').slice(0, 18);
  const content = [
    'BT',
    '/F1 22 Tf',
    '72 720 Td',
    `(${title.replace(/[()\\]/g, '')}) Tj`,
    '/F1 12 Tf',
    '0 -32 Td',
    ...lines.flatMap((line) => [`(${line.replace(/[()\\]/g, '')}) Tj`, '0 -18 Td']),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function seed({ force = process.argv.includes('--force') } = {}) {
  if (force) {
    await fs.rm(root, { recursive: true, force: true });
    console.log('· removed existing share root');
  }

  for (const dir of ['Inbox', 'Photos', 'Documents', 'Downloads']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }

  let written = 0;
  for (const [relative, content] of Object.entries(TEXT_FILES)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    written += 1;
  }

  const pdfTarget = path.join(root, 'Documents/Transfer design.pdf');
  await fs.writeFile(
    pdfTarget,
    minimalPdf('TransDev - transfer design', [
      '1. Phone runs an HTTP server on the LAN.',
      '2. Desktop pairs with a 4 digit PIN shown on the phone.',
      '3. The session token is kept in sessionStorage only.',
      '4. Uploads are sliced into 4 MB chunks and resumed on failure.',
      '5. Downloads support Range requests for video seeking.',
      '',
      'Threat model: anyone on the same Wi-Fi can reach the port,',
      'so every data route requires a bearer token and pairing is',
      'rate limited to 5 attempts per minute.',
    ].join('\n')),
  );
  written += 1;

  for (const [source, destination] of IMAGES) {
    const from = path.join(assets, source);
    const to = path.join(root, destination);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.copyFile(from, to);
      written += 1;
    } catch {
      // demo photos are optional; skip quietly if they were not generated
    }
  }

  console.log(`✓ seeded ${written} files into ${root}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed();
}

export { seed, minimalPdf };
