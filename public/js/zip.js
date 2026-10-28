/**
 * 极简 ZIP 打包（浏览器端，零依赖）：只用 STORE（不压缩），JPEG/PNG 本来就压过了。
 * 结构：每个文件「本地文件头 + 数据」，最后是中央目录和目录结束记录。
 * 文件名按 UTF-8 写入并置通用标志位 bit 11，中文名在 macOS / Windows 解压都不乱码。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP 里的修改时间用 DOS 格式：2 秒精度，年份从 1980 起 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const encoder = new TextEncoder();

/**
 * files: { name: string, data: Uint8Array | string }[]（字符串按 UTF-8 编码）
 * 返回 application/zip 的 Blob
 */
export function createZip(files, { date = new Date() } = {}) {
  const { time, date: day } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // 本地文件头签名
    local.setUint16(4, 20, true); // 解压所需版本 2.0
    local.setUint16(6, 0x0800, true); // bit 11：文件名是 UTF-8
    local.setUint16(8, 0, true); // 0 = STORE
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // 压缩后大小
    local.setUint32(22, data.length, true); // 原始大小
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // 扩展字段长度
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // 中央目录签名
    entry.setUint16(4, 20, true); // 创建版本
    entry.setUint16(6, 20, true); // 解压所需版本
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true); // 扩展字段
    entry.setUint16(32, 0, true); // 注释
    entry.setUint16(34, 0, true); // 起始磁盘号
    entry.setUint16(36, 0, true); // 内部属性
    entry.setUint32(38, 0, true); // 外部属性
    entry.setUint32(42, offset, true); // 本地文件头偏移
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // 目录结束记录签名
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true); // 中央目录起始偏移
  end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** data:image/...;base64,xxx -> { bytes, ext } */
export function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!match) throw new Error('图片数据无效');
  const [, mime, isBase64, payload] = match;
  let bytes;
  if (isBase64) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = encoder.encode(decodeURIComponent(payload));
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { bytes, ext };
}
