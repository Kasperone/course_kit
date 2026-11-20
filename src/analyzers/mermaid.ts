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

  render(direction = 'LR'): string {
    const lines = [`flowchart ${direction}`]
    for (const [label, id] of this.ids) {
      lines.push(`  ${id}["${label.replace(/"/g, '#quot;')}"]`)
    }
    for (const e of this.edges) lines.push(`  ${e}`)
    return lines.join('\n')
  }
}
