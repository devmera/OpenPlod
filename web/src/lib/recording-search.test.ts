import { expect, test } from 'bun:test'
import { searchRecording } from './recording-search'

test('finds summary lines first, then transcript segments, case-insensitively', () => {
  const summary = [{ id: 'k0', section: 'Key points', text: 'Migrate to microservices by April 1' }]
  const segment = (id: string, text: string) => ({ id, text, speaker: 'Thor', speakerId: 0, startTime: 1, endTime: 2 })
  const hits = searchRecording('microservices', summary, [segment('s1', 'The Microservices migration'), segment('s2', 'Unrelated')])
  expect(hits.map(hit => hit.kind === 'summary' ? hit.line.id : hit.segment.id)).toEqual(['k0', 's1'])
  expect(searchRecording('', summary, [])).toEqual([])
})
