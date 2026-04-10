import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const distDir = join(repoRoot, 'dist');

const shikiJs = `/*! based on https://github.com/shikijs/shiki/blob/main/packages/monaco/src/index.ts */

import { EncodedTokenMetadata, INITIAL } from '@shikijs/core/textmate';

export function textmateThemeToMonacoTheme(theme) {
  const rules = [];
  for (const { scope, settings } of theme.tokenColors ?? theme.settings) {
    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const s of scopes) {
      if (s && settings?.foreground) {
        rules.push({
          token: s,
          foreground: normalizeColor(theme.bg, settings.foreground),
          fontStyle: settings?.fontStyle
        });
      }
    }
  }
  return {
    base: theme.type === 'dark' ? 'vs-dark' : 'vs',
    colors: Object.fromEntries(
      Object.entries(theme.colors ?? {})
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, normalizeColor(theme.bg, value)])
    ),
    inherit: false,
    rules
  };
}

const tokenizeMaxLineLength = 20000;
const tokenizeTimeLimit = 500;
const colorMap = [];
const colorToScopeMap = new Map();

export function initShikiMonacoTokenizer(monaco, highlighter) {
  const themeMap = new Map();
  const themeIds = highlighter.getLoadedThemes();
  for (const themeId of themeIds) {
    const tmTheme = highlighter.getTheme(themeId);
    const monacoTheme = textmateThemeToMonacoTheme(tmTheme);
    themeMap.set(themeId, monacoTheme);
    monaco.editor.defineTheme(themeId, monacoTheme);
  }

  const setTheme = monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = (themeId) => {
    const theme = themeMap.get(themeId);
    if (!theme) {
      console.warn('Theme not found:', themeId);
      return;
    }
    const ret = highlighter.setTheme(themeId);
    colorMap.length = ret.colorMap.length;
    ret.colorMap.forEach((color, i) => {
      colorMap[i] = normalizeColor(ret.theme.bg, color);
    });
    colorToScopeMap.clear();
    theme.rules.forEach((rule) => {
      const color = rule.foreground;
      if (color && !colorToScopeMap.has(color)) {
        colorToScopeMap.set(color, rule.token);
      }
    });
    setTheme(themeId);
  };

  monaco.editor.setTheme(themeIds[0]);
}

export function registerShikiMonacoTokenizer(monaco, highlighter, languageId) {
  if (!highlighter.getLoadedLanguages().includes(languageId)) {
    return;
  }

  monaco.languages.setTokensProvider(languageId, {
    getInitialState() {
      return new TokenizerState(INITIAL);
    },
    tokenize(line, state) {
      if (line.length >= tokenizeMaxLineLength) {
        return {
          endState: state,
          tokens: [{ startIndex: 0, scopes: '' }]
        };
      }

      const grammar = highlighter.getLanguage(languageId);
      const result = grammar.tokenizeLine2(line, state.ruleStack, tokenizeTimeLimit);
      if (result.stoppedEarly) {
        console.warn(\`Time limit reached when tokenizing line: \${line.substring(0, 100)}\`);
      }

      const tokensLength = result.tokens.length / 2;
      const tokens = new Array(tokensLength);
      for (let j = 0; j < tokensLength; j++) {
        const startIndex = result.tokens[2 * j];
        const metadata = result.tokens[2 * j + 1];
        const color = colorMap[EncodedTokenMetadata.getForeground(metadata)] ?? '';
        const scope = colorToScopeMap.get(color) ?? '';
        tokens[j] = { startIndex, scopes: scope };
      }

      return { endState: new TokenizerState(result.ruleStack), tokens };
    }
  });
}

export class TokenizerState {
  constructor(ruleStack) {
    this._ruleStack = ruleStack;
  }

  get ruleStack() {
    return this._ruleStack;
  }

  clone() {
    return new TokenizerState(this._ruleStack);
  }

  equals(other) {
    return other instanceof TokenizerState && other === this && other._ruleStack === this._ruleStack;
  }
}

function toRGBA(hex) {
  const start = hex.charCodeAt(0) === 35 ? 1 : 0;
  const step = hex.length - start >= 6 ? 2 : 1;
  const rgba = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const j = start + i * step;
    rgba[i] = parseInt(hex.slice(j, j + step).repeat(3 - step), 16);
  }
  if (Number.isNaN(rgba[3])) {
    rgba[3] = 1;
  } else {
    rgba[3] /= 255;
  }
  return rgba;
}

function toHexColor(rgb) {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function channelMixer(channelA, channelB, amount) {
  return Math.round(channelA * (1 - amount) + channelB * amount);
}

function normalizeColor(bg, fg) {
  const fgRgba = toRGBA(Array.isArray(fg) ? fg[0] : fg);
  if (fgRgba[3] === 1) {
    return toHexColor(fgRgba.slice(0, 3));
  }
  const bgRgba = toRGBA(bg);
  return toHexColor([0, 1, 2].map((i) => channelMixer(bgRgba[i], fgRgba[i], fgRgba[3])));
}
`;

const shikiDts = `import type { ShikiPrimitive, ThemeRegistrationResolved } from '@shikijs/types';
import type { StateStack } from '@shikijs/core/textmate';
import type * as monacoNs from 'monaco-editor';

export interface MonacoTheme extends monacoNs.editor.IStandaloneThemeData {}
export declare function textmateThemeToMonacoTheme(theme: ThemeRegistrationResolved): MonacoTheme;
export declare function initShikiMonacoTokenizer(monaco: typeof monacoNs, highlighter: ShikiPrimitive<any, any>): void;
export declare function registerShikiMonacoTokenizer(monaco: typeof monacoNs, highlighter: ShikiPrimitive<any, any>, languageId: string): void;
export declare class TokenizerState implements monacoNs.languages.IState {
  private _ruleStack;
  constructor(_ruleStack: StateStack);
  get ruleStack(): StateStack;
  clone(): TokenizerState;
  equals(other: monacoNs.languages.IState): boolean;
}
`;

async function run(cmd, args, cwd) {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd });
  return { stdout, stderr };
}

async function main() {
  const sourcePkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const version = sourcePkg.version;
  const forkSha = (await run('git', ['rev-parse', '--short=12', 'HEAD'], repoRoot)).stdout.trim();
  const workDir = await mkdtemp(join(tmpdir(), 'monaco-fork-release-'));

  try {
    await mkdir(distDir, { recursive: true });

    await run('npm', ['pack', `monaco-editor@${version}`], workDir);
    const upstreamTgz = join(workDir, `monaco-editor-${version}.tgz`);
    await run('tar', ['-xzf', upstreamTgz], workDir);

    const pkgDir = join(workDir, 'package');
    const shikiDir = join(pkgDir, 'esm', 'vs', 'shiki');
    await mkdir(shikiDir, { recursive: true });
    await writeFile(join(shikiDir, 'index.js'), shikiJs);
    await writeFile(join(shikiDir, 'index.d.ts'), shikiDts);

    const pkgJsonPath = join(pkgDir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
    pkg.private = false;
    pkg.repository = {
      type: 'git',
      url: 'https://github.com/ggiampietro/monaco-editor'
    };
    pkg.homepage = 'https://github.com/ggiampietro/monaco-editor';
    pkg.exports = {
      ...(pkg.exports ?? {}),
      './shiki': {
        types: './esm/vs/shiki/index.d.ts',
        import: './esm/vs/shiki/index.js'
      }
    };
    pkg.dependencies = {
      ...(pkg.dependencies ?? {}),
      '@shikijs/core': '4.0.1',
      '@shikijs/types': '4.0.1'
    };
    pkg.forkSource = {
      repo: 'ggiampietro/monaco-editor',
      commit: forkSha
    };
    await writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const releaseName = `monaco-editor-${version}-shiki-fork-${forkSha}.tgz`;
    await run('npm', ['pack', pkgDir], workDir);
    await copyFile(join(workDir, `monaco-editor-${version}.tgz`), join(distDir, releaseName));

    const notes = [
      `Built fork artifact for monaco-editor ${version}.`,
      ``,
      `Source fork commit: ${forkSha}`,
      `Base upstream package: monaco-editor@${version}`,
      ``,
      `Added:`,
      `- esm/vs/shiki/index.js`,
      `- esm/vs/shiki/index.d.ts`,
      `- package export ./shiki`,
      `- dependencies @shikijs/core and @shikijs/types`,
      ``,
      `Install with:`,
      `npm install /absolute/path/to/dist/${releaseName}`,
      `or`,
      `pnpm add /absolute/path/to/dist/${releaseName}`,
      ``
    ].join('\n');

    await writeFile(join(distDir, `${releaseName}.txt`), notes);
    console.log(`Created ${join(distDir, releaseName)}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
