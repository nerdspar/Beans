/**
 * Every prose string literal in the web app, wherever it sits.
 *
 * The first pass only looked at JSX text and a list of text-bearing props, and missed
 * `{cond ? 'Showing household net worth' : …}` entirely — a user-facing string in an expression
 * container. So this looks at *all* string literals and filters by what they look like instead.
 */
import ts from 'typescript'
import { readFileSync, globSync } from 'node:fs'

const files = globSync('apps/web/src/**/*.tsx', { cwd: process.cwd() })

function isProse(raw) {
  const text = raw.trim()
  if (text.length < 12) return false
  if (!/[a-z]/.test(text)) return false
  if (!/\s/.test(text)) return false
  if (/^https?:|^\.{0,2}\//.test(text)) return false
  // Tailwind-ish: mostly tokens with hyphens/colons and no sentence punctuation.
  if (/(?:^|\s)(?:flex|text-|bg-|border|grid|gap-|px-|py-|mt-|mb-|rounded|absolute|relative|hover:|dark:|focus:|min-|max-|w-|h-)/.test(text))
    return false
  const words = text.split(/\s+/).filter((w) => /[aeiou]/i.test(w) && /^[A-Za-z’'“”.,!?—–:;()-]+$/.test(w))
  return words.length >= 2
}

const findings = []

for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return

    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim()
      if (isProse(text)) findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
    }

    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isProse(node.text)) {
      const parent = node.parent
      // className={...} and the like are styling, not copy.
      const isClassName =
        ts.isJsxAttribute(parent) && parent.name.getText() === 'className'
      if (!isClassName) {
        findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text })
      }
    }

    if (ts.isTemplateExpression(node)) {
      const joined = node.head.text + node.templateSpans.map((s) => '…' + s.literal.text).join('')
      if (isProse(joined)) {
        findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: joined })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
}

const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}

console.log(`${findings.length} candidate strings across ${byFile.size} files\n`)
for (const [file, items] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`--- ${file} (${items.length})`)
  for (const i of items) console.log(`  ${i.line}  ${i.text.slice(0, 105)}`)
}
