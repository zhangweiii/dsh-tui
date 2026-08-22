/**
 * Minimal schema/draft helpers inlined from `@deepseek-ai/dsh-client-schema-form`.
 *
 * The upstream package stopped at 0.1.0-rc.7 and its peer ranges (`dsh-invariants
 * ^0.1.0-rc.7`) are incompatible with the 0.1.1 line, so it can no longer live in
 * this package's dependency graph. Only the three functions the TUI actually uses
 * are inlined here; the rest of the upstream module (validateDraft, setPath, ...)
 * served the Web settings editors and is not needed by the terminal provider flow.
 *
 * Source: @deepseek-ai/dsh-client-schema-form@0.1.0-rc.6, lib/index.js + lib/types/model.d.ts
 * (MIT license, DeepSeek Harness). Behavior is kept byte-for-byte.
 *
 * @module @zhangweiii/dsh-tui/schema-form
 */
import Schema from '@deepseek-ai/schemastery'

/** Live schemastery node; consumers read only its structural relations. */
export type SchemaNode = Schema

/**
 * Rehydrate a serialized schema envelope into a live validator/node tree.
 * @param serialized - `schema.toJSON()` output received over the wire.
 * @returns the root schema node.
 */
export function rehydrateSchema(serialized: unknown): SchemaNode {
  return new Schema(serialized as never)
}

/**
 * Resolve the schema node at a settings path (the configurable-provider
 * directory's `settingsPath` vocabulary): object properties by name, dict
 * entries through `inner`. An unresolvable segment returns `undefined` so
 * the caller falls back instead of rendering a wrong subtree.
 * @param root - rehydrated section root node.
 * @param path - key path from the section root.
 * @returns the node describing that position, or `undefined`.
 */
export function nodeAtPath(
  root: SchemaNode,
  path: readonly string[],
): SchemaNode | undefined {
  let node: SchemaNode | undefined = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = node.dict?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner
    else return undefined
  }
  return node
}

/**
 * Read a nested value by path.
 * @param value - root value (draft or fallback layer).
 * @param path - key path from the root; array indexes as strings.
 * @returns the value at the path, or `undefined` along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
