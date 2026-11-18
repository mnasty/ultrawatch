export const meta = {
  name: 'demo-running',
  description: 'A running demo workflow with three agents',
  phases: [
    { title: 'Design', detail: 'two designers in parallel' },
    { title: 'Build', detail: 'one builder' }, // trailing comma and comment on purpose
  ],
}
phase('Design')
const a = await agent(`design one; mention agent( in a string must not count`, { label: 'design:one', phase: 'Design' })
const b = await agent('design two', { label: 'design:two', phase: 'Design' })
phase('Build')
const c = await agent('build', { label: 'build:main', phase: 'Build' })
phase('Verify')
await agent('verify', { label: 'verify', phase: 'Verify' })
