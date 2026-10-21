const TYPES = {
  // images
  jpg: ['image/jpeg', 'image'],
  jpeg: ['image/jpeg', 'image'],
  png: ['image/png', 'image'],
  gif: ['image/gif', 'image'],
  webp: ['image/webp', 'image'],
  avif: ['image/avif', 'image'],
  heic: ['image/heic', 'image'],
  heif: ['image/heif', 'image'],
  svg: ['image/svg+xml', 'image'],
  bmp: ['image/bmp', 'image'],
  tif: ['image/tiff', 'image'],
  tiff: ['image/tiff', 'image'],
  ico: ['image/x-icon', 'image'],

  // video
  mp4: ['video/mp4', 'video'],
  m4v: ['video/mp4', 'video'],
  mov: ['video/quicktime', 'video'],
  webm: ['video/webm', 'video'],
  mkv: ['video/x-matroska', 'video'],
  avi: ['video/x-msvideo', 'video'],
  '3gp': ['video/3gpp', 'video'],

  // audio
  mp3: ['audio/mpeg', 'audio'],
  m4a: ['audio/mp4', 'audio'],
  wav: ['audio/wav', 'audio'],
  ogg: ['audio/ogg', 'audio'],
  opus: ['audio/opus', 'audio'],
  flac: ['audio/flac', 'audio'],
  aac: ['audio/aac', 'audio'],

  // documents
  pdf: ['application/pdf', 'pdf'],
  doc: ['application/msword', 'document'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
  xls: ['application/vnd.ms-excel', 'spreadsheet'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
  ppt: ['application/vnd.ms-powerpoint', 'presentation'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
  txt: ['text/plain; charset=utf-8', 'text'],
  md: ['text/markdown; charset=utf-8', 'text'],
  markdown: ['text/markdown; charset=utf-8', 'text'],
  csv: ['text/csv; charset=utf-8', 'spreadsheet'],
  json: ['application/json; charset=utf-8', 'code'],
  js: ['text/javascript; charset=utf-8', 'code'],
  mjs: ['text/javascript; charset=utf-8', 'code'],
  ts: ['text/plain; charset=utf-8', 'code'],
  tsx: ['text/plain; charset=utf-8', 'code'],
  css: ['text/css; charset=utf-8', 'code'],
  html: ['text/html; charset=utf-8', 'code'],
  xml: ['application/xml; charset=utf-8', 'code'],
  yml: ['text/yaml; charset=utf-8', 'code'],
  yaml: ['text/yaml; charset=utf-8', 'code'],
  log: ['text/plain; charset=utf-8', 'text'],

  // archives
  zip: ['application/zip', 'archive'],
  rar: ['application/vnd.rar', 'archive'],
  '7z': ['application/x-7z-compressed', 'archive'],
  tar: ['application/x-tar', 'archive'],
  gz: ['application/gzip', 'archive'],

  // misc
  apk: ['application/vnd.android.package-archive', 'app'],
  epub: ['application/epub+zip', 'document'],
  vcf: ['text/vcard; charset=utf-8', 'contact'],
};

const INLINE_KINDS = new Set(['image', 'video', 'audio', 'pdf', 'text', 'code']);

export function extensionOf(name = '') {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function describeFile(name) {
  const ext = extensionOf(name);
  const [mime, kind] = TYPES[ext] ?? ['application/octet-stream', 'file'];
  return { ext, mime, kind, inline: INLINE_KINDS.has(kind) };
}

export function isTextLike(kind) {
  return kind === 'text' || kind === 'code';
}
