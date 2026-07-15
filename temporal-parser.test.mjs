// Regression tests for English/Chinese temporal cue parsing.
// Run: node temporal-parser.test.mjs

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

let parseTemporalWindow
try {
  ({ parseTemporalWindow } = await import('./lib/temporal-parser.mjs'))
} catch (error) {
  check('temporal parser module is importable', false, error.message)
}

if (parseTemporalWindow) {
  const originalNow = Date.now
  Date.now = () => new Date(2026, 6, 15, 12, 0, 0, 0).getTime()

  const dayWindow = (year, monthIndex, day) => ({
    from: new Date(year, monthIndex, day, 0, 0, 0, 0).getTime(),
    to: new Date(year, monthIndex, day, 23, 59, 59, 999).getTime(),
  })
  const rangeWindow = (from, to) => ({
    from: dayWindow(...from).from,
    to: dayWindow(...to).to,
  })
  const sameWindow = (actual, expected) =>
    actual?.from === expected.from && actual?.to === expected.to

  try {
    check('“什么时候讨论了 X” is a time question, not a temporal filter',
      parseTemporalWindow('什么时候讨论了 X') === null)

    const lastWeek = parseTemporalWindow('上周开了几个会')
    check('“上周” spans today minus seven days through today',
      sameWindow(lastWeek, rangeWindow([2026, 6, 8], [2026, 6, 15])) && lastWeek.matched === '上周',
      JSON.stringify(lastWeek))

    const yesterday = parseTemporalWindow("yesterday's decision on Y")
    check('“yesterday” spans the previous local calendar day',
      sameWindow(yesterday, dayWindow(2026, 6, 14)) && yesterday.matched === 'yesterday',
      JSON.stringify(yesterday))

    const may2026 = parseTemporalWindow('decisions made in May 2026')
    check('“in May 2026” spans the named calendar month',
      sameWindow(may2026, rangeWindow([2026, 4, 1], [2026, 4, 31])) && may2026.matched === 'in May 2026',
      JSON.stringify(may2026))

    const chineseMay = parseTemporalWindow('5月做了什么')
    check('“5月” uses the most recent matching calendar month',
      sameWindow(chineseMay, rangeWindow([2026, 4, 1], [2026, 4, 31])) && chineseMay.matched === '5月',
      JSON.stringify(chineseMay))

    const lastMonth = parseTemporalWindow('上个月的项目进展')
    check('“上个月” spans the previous calendar month',
      sameWindow(lastMonth, rangeWindow([2026, 5, 1], [2026, 5, 30])) && lastMonth.matched === '上个月',
      JSON.stringify(lastMonth))

    const pastThreeDays = parseTemporalWindow('the past 3 days of incidents')
    check('“the past 3 days” includes today and the previous two days',
      sameWindow(pastThreeDays, rangeWindow([2026, 6, 13], [2026, 6, 15])) && pastThreeDays.matched === 'the past 3 days',
      JSON.stringify(pastThreeDays))

    const chinesePastThreeDays = parseTemporalWindow('过去三天的会议')
    check('“过去三天” includes today and the previous two days',
      sameWindow(chinesePastThreeDays, rangeWindow([2026, 6, 13], [2026, 6, 15])) && chinesePastThreeDays.matched === '过去三天',
      JSON.stringify(chinesePastThreeDays))

    check('query without a temporal cue returns null',
      parseTemporalWindow('decision on Y') === null)
  } finally {
    Date.now = originalNow
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
