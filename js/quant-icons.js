/**
 * 轻量 SVG 图标（替代全量 Font Awesome）
 */

const PATHS = {
  sparkles: 'M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  check: 'M5 12l5 5L20 7',
  xmark: 'M6 6l12 12M18 6L6 18',
  warning: 'M12 9v4M12 17h.01M10.3 4.2l-7.5 13A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8l-7.5-13a2 2 0 0 0-3.4 0z',
  paperPlane: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  layers: 'M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  server: 'M4 6h16v4H4V6zm0 8h16v4H4v-4zM8 8h.01M8 16h.01',
  database: 'M12 3c4.4 0 8 1.8 8 4s-3.6 4-8 4-8-1.8-8-4 3.6-4 8-4zM4 7v5c0 2.2 3.6 4 8 4s8-1.8 8-4V7M4 12v5c0 2.2 3.6 4 8 4s8-1.8 8-4v-5',
  cpu: 'M9 9h6v6H9V9zM4 9h2M4 15h2M18 9h2M18 15h2M9 4v2M15 4v2M9 18v2M15 18v2',
  chart: 'M4 19V5M4 19h16M8 15l3-4 3 2 4-6',
};

/**
 * 生成内联 SVG HTML（已无用户输入，仅用于可信图标键）
 * @param {string} name
 * @param {{ spin?: boolean, className?: string, size?: number }} [opts]
 */
export function iconHtml(name, opts = {}) {
  const d = PATHS[name] || PATHS.sparkles;
  const size = opts.size || 16;
  const spin = opts.spin ? ' qi-spin' : '';
  const extra = opts.className ? ` ${opts.className}` : '';
  return `<svg class="qi${spin}${extra}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** 写入宿主元素 */
export function setIcon(host, name, opts = {}) {
  if (!host) return;
  host.innerHTML = iconHtml(name, opts);
}
