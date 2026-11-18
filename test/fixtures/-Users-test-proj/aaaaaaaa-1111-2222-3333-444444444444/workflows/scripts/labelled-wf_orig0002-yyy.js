export const meta = { name: 'labelled', description: 'Found by its labels', phases: [{ title: 'Lab' }] }
phase('Lab')
await agent('a', { label: 'lab:alpha' })
await agent('b', { label: "lab:beta" })
