/** Small Mermaid flowchart builder with stable generated ids and quoted labels. */
export class FlowchartBuilder {
  private readonly ids = new Map<string, string>()
  private readonly edges = new Set<string>()

  node(label: string): string {
    let id = this.ids.get(label)
    if (!id) {
      id = `n${this.ids.size}`
      this.ids.set(label, id)
    }
    return id
  }

  edge(from: string, to: string): void {
    if (from === to) return
    this.edges.add(`${this.node(from)} --> ${this.node(to)}`)
  }

  get isEmpty(): boolean {
    return this.ids.size === 0
  }

  /**
   * Render the flowchart. With `groupPrefix`, every node whose label is `prefix` or starts with
   * `prefix.` is drawn inside one subgraph titled by the prefix, with the prefix stripped from its
   * label (the prefix itself becomes `(root)`), which keeps long package names readable.
   */
  render(direction = 'LR', opts: { groupPrefix?: string } = {}): string {
    const quote = (s: string) => `"${s.replace(/"/g, '#quot;')}"`
    const prefix = opts.groupPrefix
    const inGroup = (label: string) =>
      prefix !== undefined && (label === prefix || label.startsWith(`${prefix}.`))
    const lines = [`flowchart ${direction}`]
    const grouped = [...this.ids].filter(([label]) => inGroup(label))
    if (grouped.length > 0) {
      lines.push(`  subgraph g0[${quote(prefix!)}]`)
      for (const [label, id] of grouped) {
        const short = label === prefix ? '(root)' : label.slice(prefix!.length + 1)
        lines.push(`    ${id}[${quote(short)}]`)
      }
      lines.push('  end')
    }
    for (const [label, id] of this.ids) {
      if (!inGroup(label)) lines.push(`  ${id}[${quote(label)}]`)
    }
    for (const e of this.edges) lines.push(`  ${e}`)
    return lines.join('\n')
  }
}
