const ENGLISH_MONTHS = new Map([
  ['january', 0], ['february', 1], ['march', 2], ['april', 3],
  ['may', 4], ['june', 5], ['july', 6], ['august', 7],
  ['september', 8], ['october', 9], ['november', 10], ['december', 11],
])

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function addDays(date, amount) {
  const result = new Date(date)
  result.setDate(result.getDate() + amount)
  return result
}

function windowFor(from, to, matched) {
  return {
    from: startOfDay(from).getTime(),
    to: endOfDay(to).getTime(),
    matched,
  }
}

function monthWindow(year, monthIndex, matched) {
  const first = new Date(year, monthIndex, 1)
  const last = new Date(year, monthIndex + 1, 0)
  return windowFor(first, last, matched)
}

function mostRecentMonthYear(now, monthIndex) {
  return monthIndex > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear()
}

function parseChineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  if (!value.includes('十')) return digits[value] ?? NaN
  const [tens, ones] = value.split('十')
  return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0)
}

/**
 * Extract a common English or Chinese temporal cue from a recall query.
 * Returned timestamps are inclusive local-calendar day boundaries in milliseconds.
 *
 * @param {string} query
 * @returns {{from: number, to: number, matched: string} | null}
 */
export function parseTemporalWindow(query) {
  if (typeof query !== 'string' || query.trim() === '') return null

  const now = new Date(Date.now())
  const today = startOfDay(now)
  let match

  match = query.match(/\byesterday\b|昨天/i)
  if (match) {
    const yesterday = addDays(today, -1)
    return windowFor(yesterday, yesterday, match[0])
  }

  match = query.match(/\b(?:last|previous)\s+week\b|上(?:一)?周|上(?:一)?星期/i)
  if (match) return windowFor(addDays(today, -7), today, match[0])

  match = query.match(/\b(?:last|previous)\s+month\b|上(?:个|一)?月/i)
  if (match) {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return monthWindow(previousMonth.getFullYear(), previousMonth.getMonth(), match[0])
  }

  match = query.match(/\b(?:the\s+)?(?:past|last)\s+(\d{1,3})\s+days?\b/i)
  if (match) {
    const days = Number(match[1])
    if (days >= 1) return windowFor(addDays(today, -(days - 1)), today, match[0])
  }

  match = query.match(/(?:过去|近)([一二两三四五六七八九十\d]{1,3})天/)
  if (match) {
    const days = parseChineseNumber(match[1])
    if (Number.isInteger(days) && days >= 1) {
      return windowFor(addDays(today, -(days - 1)), today, match[0])
    }
  }

  const englishMonthNames = Array.from(ENGLISH_MONTHS.keys()).join('|')
  match = query.match(new RegExp(`\\b(?:in\\s+)?(${englishMonthNames})(?:\\s+(\\d{4}))?\\b`, 'i'))
  if (match) {
    const monthIndex = ENGLISH_MONTHS.get(match[1].toLowerCase())
    const year = match[2] ? Number(match[2]) : mostRecentMonthYear(now, monthIndex)
    return monthWindow(year, monthIndex, match[0])
  }

  match = query.match(/(?:(\d{4})年)?(1[0-2]|0?[1-9])月/)
  if (match) {
    const monthIndex = Number(match[2]) - 1
    const year = match[1] ? Number(match[1]) : mostRecentMonthYear(now, monthIndex)
    return monthWindow(year, monthIndex, match[0])
  }

  match = query.match(/\btoday\b|今天/i)
  if (match) return windowFor(today, today, match[0])

  return null
}
