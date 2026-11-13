import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const package_version = String(package_json.version ?? '');
const manifest_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));

// 浏览器固定从 /scripts/extensions/third-party/<插件>/<manifest.js> 加载入口模块。
// 直接按运行时 URL 层级计算回到酒馆 public/ 根的相对路径,不依赖构建机源码检出位置:
// 例如 manifest.js 为 `dist/index.js?ver=...` 时,`@sillytavern/scripts/xxx` -> `../../../../../scripts/xxx.js`。
export function resolveRuntimeSillyTavernRelativePath(manifestJs = manifest_json.js) {
  const rawEntry = String(manifestJs ?? '')
    .split(/[?#]/, 1)[0]
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  const normalizedEntry = rawEntry ? path.posix.normalize(rawEntry) : '';
  if (!normalizedEntry || normalizedEntry === '.' || normalizedEntry === '..' || normalizedEntry.startsWith('../')) {
    throw new Error(`Invalid manifest.json "js" entry path: ${String(manifestJs ?? '')}`);
  }
  const runtimeEntryDir = path.posix.dirname(
    path.posix.join('/scripts/extensions/third-party/_extension_', normalizedEntry),
  );
  return path.posix.relative(runtimeEntryDir, '/');
}

export function resolveSillyTavernImportSpecifier(id, relativeRoot = relative_sillytavern_path) {
  if (typeof id !== 'string' || !id.startsWith('@sillytavern/')) {
    return null;
  }
  const subpath = id
    .slice('@sillytavern/'.length)
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\.js$/i, '');
  if (!subpath || subpath === '.' || subpath === '..' || subpath.startsWith('../') || subpath.includes('/../')) {
    throw new Error(`Invalid @sillytavern import specifier: ${id}`);
  }
  return `${path.posix.join(relativeRoot, subpath)}.js`;
}

const relative_sillytavern_path = resolveRuntimeSillyTavernRelativePath();

// ST 已在全局挂载的第三方库,避免重复打包(本插件目前直接用全局 $/toastr,不 import)。
const globals = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

export default defineConfig(({ mode }) => ({
  define: {
    __BBT_VERSION__: JSON.stringify(package_version),
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },

  plugins: [
    {
      name: 'sillytavern-resolver',
      enforce: 'pre',
      resolveId(id) {
        const resolvedHostId = resolveSillyTavernImportSpecifier(id);
        if (resolvedHostId) {
          return {
            id: resolvedHostId,
            external: true,
          };
        }
        if (id in globals) {
          return { id, external: true };
        }
      },
    },
  ],

  build: {
    rollupOptions: {
      input: 'src/index.js',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        globals,
        // 全部打进单个 index.js:云端/高延迟环境下,一个大文件(gzip 后一次
        // 请求)比十来个懒加载 chunk 的多次往返加载得更快;Vue/CodeMirror 等
        // 动态 import 会被内联,import() 调用点原样保留、立即 resolve。
        inlineDynamicImports: true,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
