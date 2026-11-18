export const meta = { name: 'relaunch-demo', description: 'Relaunched from an existing script', phases: [{ title: 'Fix' }, { title: 'Ship' }] }
phase('Fix')
await agent('a', { label: 'fix:one' })
phase('Ship')
await agent('b', { label: 'ship:it' })
