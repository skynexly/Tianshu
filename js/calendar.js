/**
 * 日历系统 — 自定义时间计算引擎
 * 
 * 功能：
 * - 解析增量时间格式（+1h20min、+3d、-30min 等）
 * - 基于自定义日历规则做日期加减（支持每月不同天数、自定义周/季节）
 * - 自动计算星期和季节
 * - 兼容旧版绝对时间格式
 */
const Calendar = (() => {
  'use strict';

  // ===== 默认日历规则 =====
  const DEFAULT_RULES = {
    hoursPerDay: 24,
    minutesPerHour: 60,
    daysPerWeek: 7,
    weekDayNames: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
    monthsPerYear: 12,
    daysPerMonth: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    seasons: [
      { name: '春', months: [3, 4, 5], weather: '微风渐暖' },
      { name: '夏', months: [6, 7, 8], weather: '炎热潮湿' },
      { name: '秋', months: [9, 10, 11], weather: '凉爽干燥' },
      { name: '冬', months: [12, 1, 2], weather: '寒冷' }
    ],
    timePeriods: [
      { name: '凌晨', startHour: 0, desc: '天色未明，万籁俱寂' },
      { name: '早晨', startHour: 5, desc: '天色渐亮，日光初照' },
      { name: '上午', startHour: 8, desc: '日光明亮，正是活动时间' },
      { name: '中午', startHour: 11, desc: '日头正盛，光线最强' },
      { name: '下午', startHour: 14, desc: '日光偏斜，暑气渐消' },
      { name: '傍晚', startHour: 18, desc: '太阳落山，天色渐暗' },
      { name: '夜晚', startHour: 20, desc: '天色已暗，灯火亮起' },
      { name: '深夜', startHour: 23, desc: '夜深人静，一片沉寂' }
    ]
  };

  /**
   * 获取当前对话的日历规则（优先世界观设定，没有则用默认）
   */
  function getRules(customRules) {
    if (!customRules) return { ...DEFAULT_RULES };
    return {
      hoursPerDay: customRules.hoursPerDay || DEFAULT_RULES.hoursPerDay,
      minutesPerHour: customRules.minutesPerHour || DEFAULT_RULES.minutesPerHour,
      daysPerWeek: customRules.daysPerWeek || DEFAULT_RULES.daysPerWeek,
      weekDayNames: (customRules.weekDayNames && customRules.weekDayNames.length > 0)
        ? customRules.weekDayNames
        : DEFAULT_RULES.weekDayNames,
      monthsPerYear: customRules.monthsPerYear || DEFAULT_RULES.monthsPerYear,
      daysPerMonth: (customRules.daysPerMonth && customRules.daysPerMonth.length > 0)
        ? customRules.daysPerMonth
        : DEFAULT_RULES.daysPerMonth,
      seasons: (customRules.seasons && customRules.seasons.length > 0)
      ? customRules.seasons
      : DEFAULT_RULES.seasons,
    timePeriods: (customRules.timePeriods && customRules.timePeriods.length > 0)
      ? customRules.timePeriods
      : DEFAULT_RULES.timePeriods
  };
  }

  // ===== 时间格式解析 =====

  /**
   * 解析绝对时间字符串 → 时间对象
   * 支持格式：
   * - "2026.04.15 星期二 19:30"
   * - "2026年4月15日 星期二 19:30"
   * - "2026.04.15 19:30"（无星期）
   * - "2026/04/15 19:30"
   */
  function parseAbsoluteTime(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();

    // 格式1: 2026.04.15 星期X 19:30
    let m = str.match(/(\d{1,4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})[日]?\s*(?:[\u4e00-\u9fa5]{1,4}[日曜]?)?\s*(\d{1,2}):(\d{1,2})/);
    if (m) {
      return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
    }

    // 格式2: 只有日期没有时间
    m = str.match(/(\d{1,4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})[日]?\s*(?:[\u4e00-\u9fa5]{1,4}[日曜]?)?/);
    if (m) {
      return { year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0 };
    }

    return null;
  }

  /**
   * 检测一个 time 字符串是否是增量格式
   */
  function isDelta(str) {
    if (!str || typeof str !== 'string') return false;
    return /^\s*[+\-]/.test(str.trim());
  }

  /**
   * 解析增量时间字符串 → 分钟总增量
   * 支持格式（大小写不敏感，允许空格分隔）：
   * - "+20min" / "+20分钟" / "+20m"
   * - "+1h" / "+1小时" / "+1hour"
   * - "+3d" / "+3天" / "+3day"
   * - "+2month" / "+2月" / "+2个月"
   * - "+1year" / "+1年" / "+1y"
   * - 组合: "+1h20min" / "+2d6h" / "+1天3小时20分钟"
   * - 负数: "-30min" / "-1h"
   * - 小数: "+1.5h" / "+0.5d"
   * 
   * 返回: { years, months, days, hours, minutes } 各维度增量（保留分维度用于跨月计算）
   */
  function parseDelta(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();

    const sign = str.startsWith('-') ? -1 : 1;
    // 去掉开头的正负号
    str = str.replace(/^[+\-]\s*/, '');

    if (!str) return null;

    const result = { years: 0, months: 0, days: 0, hours: 0, minutes: 0 };
    let matched = false;

    // 年
    const yearPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:year|years|yr|y|年)/gi
    ];
    for (const p of yearPatterns) {
      let rm;
      while ((rm = p.exec(str)) !== null) {
        result.years += parseFloat(rm[1]);
        matched = true;
      }
    }

    // 月
    const monthPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:month|months|mon|个月|月)/gi
    ];
    for (const p of monthPatterns) {
      let rm;
      while ((rm = p.exec(str)) !== null) {
        result.months += parseFloat(rm[1]);
        matched = true;
      }
    }

    // 天
    const dayPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:day|days|d|天)/gi
    ];
    for (const p of dayPatterns) {
      let rm;
      while ((rm = p.exec(str)) !== null) {
        result.days += parseFloat(rm[1]);
        matched = true;
      }
    }

    // 小时
    const hourPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|h|小时)/gi
    ];
    for (const p of hourPatterns) {
      let rm;
      while ((rm = p.exec(str)) !== null) {
        result.hours += parseFloat(rm[1]);
        matched = true;
      }
    }

    // 分钟
    const minPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:minute|minutes|min|m(?!on)|分钟|分)/gi
    ];
    for (const p of minPatterns) {
      let rm;
      while ((rm = p.exec(str)) !== null) {
        result.minutes += parseFloat(rm[1]);
        matched = true;
      }
    }

    // 如果什么都没匹配到，尝试纯数字当分钟处理
    if (!matched) {
      const numOnly = str.match(/^(\d+(?:\.\d+)?)$/);
      if (numOnly) {
        result.minutes = parseFloat(numOnly[1]);
        matched = true;
      }
    }

    if (!matched) return null;

    // 应用正负号
    result.years *= sign;
    result.months *= sign;
    result.days *= sign;
    result.hours *= sign;
    result.minutes *= sign;

    return result;
  }

  // ===== 日期加减运算 =====

  /**
   * 对时间对象应用增量，返回新时间对象
   * @param {object} time - { year, month, day, hour, minute }
   * @param {object} delta - { years, months, days, hours, minutes }
   * @param {object} rules - 日历规则
   * @returns {object} 新时间对象
   */
  function addDelta(time, delta, rules) {
    if (!time || !delta) return time;
    rules = getRules(rules);

    let { year, month, day, hour, minute } = { ...time };
    const minutesPerHour = rules.minutesPerHour;
    const hoursPerDay = rules.hoursPerDay;
    const monthsPerYear = rules.monthsPerYear;

    // 1. 加年
    if (delta.years) {
      year += Math.floor(delta.years);
      // 小数年转月
      const fracYearMonths = (delta.years - Math.floor(delta.years)) * monthsPerYear;
      if (fracYearMonths) delta = { ...delta, months: (delta.months || 0) + fracYearMonths };
    }

    // 2. 加月
    if (delta.months) {
      const totalMonths = (month - 1) + Math.floor(delta.months);
      year += Math.floor(totalMonths / monthsPerYear);
      month = (totalMonths % monthsPerYear + monthsPerYear) % monthsPerYear + 1;

      // 小数月转天
      const fracMonthDays = (delta.months - Math.floor(delta.months)) * _getDaysInMonth(month, year, rules);
      if (fracMonthDays) delta = { ...delta, days: (delta.days || 0) + fracMonthDays };

      // 如果 day 超出新月的天数，钳位
      const maxDay = _getDaysInMonth(month, year, rules);
      if (day > maxDay) day = maxDay;
    }

    // 3. 加天/时/分（全部转换为分钟再统一进位）
    // 把 hour:minute 也纳入总分钟数
    const totalMinutes = hour * minutesPerHour + minute
      + (delta.minutes || 0)
      + (delta.hours || 0) * minutesPerHour
      + (delta.days || 0) * hoursPerDay * minutesPerHour;

    // 从 totalMinutes 算天偏移
    const dayMinutes = hoursPerDay * minutesPerHour;
    let dayOffset, remainMinutes;
    if (totalMinutes >= 0) {
      dayOffset = Math.floor(totalMinutes / dayMinutes);
      remainMinutes = totalMinutes - dayOffset * dayMinutes;
    } else {
      // 负数：确保 remainMinutes 在 [0, dayMinutes) 范围内
      dayOffset = -Math.ceil(-totalMinutes / dayMinutes);
      remainMinutes = totalMinutes - dayOffset * dayMinutes;
    }

    hour = Math.floor(remainMinutes / minutesPerHour);
    minute = Math.round(remainMinutes % minutesPerHour);

    // 4. 应用天偏移到日期
    if (dayOffset > 0) {
      for (let i = 0; i < dayOffset; i++) {
        day += 1;
        const maxDay = _getDaysInMonth(month, year, rules);
        if (day > maxDay) {
          day = 1;
          month += 1;
          if (month > monthsPerYear) {
            month = 1;
            year += 1;
          }
        }
      }
    } else if (dayOffset < 0) {
      for (let i = 0; i < -dayOffset; i++) {
        day -= 1;
        if (day < 1) {
          month -= 1;
          if (month < 1) {
            month = monthsPerYear;
            year -= 1;
          }
          day = _getDaysInMonth(month, year, rules);
        }
      }
    }

    return { year, month, day, hour, minute };
  }

  /**
   * 获取指定月份的天数
   */
  function _getDaysInMonth(month, year, rules) {
    const dpm = rules.daysPerMonth;
    if (!dpm || dpm.length === 0) return 30;
    const idx = ((month - 1) % dpm.length + dpm.length) % dpm.length;
    return dpm[idx] || 30;
  }

  // ===== 星期计算 =====

  /**
   * 计算星期
   * 默认历法（标准公历7天制）：用 JS Date 精确计算（含闰年）
   * 自定义历法（非7天制或自定义周天名非标准）：用 _daysSinceEpoch 按固定月天数计算
   * 
   * @param {object} time - { year, month, day }
   * @param {object} rules - 日历规则
   * @returns {string} 星期名称
   */
  function getWeekDay(time, rules) {
    rules = getRules(rules);
    // 判断是否为默认公历：7天制且周天名是标准中文星期
    const isDefaultCalendar = rules.daysPerWeek === 7 &&
      JSON.stringify(rules.weekDayNames) === JSON.stringify(DEFAULT_RULES.weekDayNames);
    if (isDefaultCalendar && time.year > 0 && time.month >= 1 && time.month <= 12 && time.day >= 1) {
      // 用 JS Date 精确算（处理闰年）
      try {
        const d = new Date(time.year, time.month - 1, time.day);
        // JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat → 转换为 weekDayNames index (0=Mon, ..., 6=Sun)
        const jsDay = d.getDay(); // 0=Sun
        const idx = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon, 1=Tue, ..., 6=Sun
        return rules.weekDayNames[idx] || `第${idx + 1}日`;
      } catch(_) {}
    }
    // 自定义历法：按固定规则算
    const totalDays = _daysSinceEpoch(time, rules);
    const weekIdx = ((totalDays % rules.daysPerWeek) + rules.daysPerWeek) % rules.daysPerWeek;
    return rules.weekDayNames[weekIdx] || `第${weekIdx + 1}日`;
  }

  /**
   * 计算从纪元（1年1月1日）到指定日期的总天数
   */
  function _daysSinceEpoch(time, rules) {
    const monthsPerYear = rules.monthsPerYear;
    let days = 0;

    // 年贡献的天数
    const daysPerYear = _getDaysInYear(rules);
    days += (time.year - 1) * daysPerYear;

    // 月贡献的天数
    for (let m = 1; m < time.month; m++) {
      days += _getDaysInMonth(m, time.year, rules);
    }

    // 日
    days += (time.day - 1);

    return days;
  }

  /**
   * 计算一年总天数
   */
  function _getDaysInYear(rules) {
    let total = 0;
    for (let m = 1; m <= rules.monthsPerYear; m++) {
      total += _getDaysInMonth(m, 1, rules);
    }
    return total;
  }

  // ===== 季节计算 =====

  /**
   * 根据当前月份获取季节
   * @param {number} month - 当前月份
   * @param {object} rules - 日历规则
   * @returns {object|null} { name, weather } 或 null
   */
  function getSeason(month, rules) {
    rules = getRules(rules);
    if (!rules.seasons || rules.seasons.length === 0) return null;
    for (const s of rules.seasons) {
      if (s.months && s.months.includes(month)) {
        return { name: s.name, weather: s.weather || '' };
      }
    }
    return null;
  }

  // ===== 时段计算 =====

  /**
   * 根据当前小时获取时段信息
   * @param {number} hour - 当前小时 (0-23)
   * @param {object} rules - 日历规则
   * @returns {object|null} { name, desc } 或 null
   */
  function getTimePeriod(hour, rules) {
    rules = getRules(rules);
    let periods = rules.timePeriods;
    if (!periods || periods.length === 0) return null;
    // 防御：过滤掉 startHour 非法（NaN/null/超出 0-23）的脏数据，并强制按 startHour 升序排序。
    // 不信任调用方/存量数据的顺序与合法性，避免 26 时起、乱序、负数等导致选错段或整段失效。
    periods = periods
      .filter(p => p && Number.isFinite(Number(p.startHour)) && Number(p.startHour) >= 0 && Number(p.startHour) <= 23)
      .map(p => ({ name: p.name, desc: p.desc || '', startHour: Number(p.startHour) }))
      .sort((a, b) => a.startHour - b.startHour);
    if (periods.length === 0) return null;
    // 找最后一个 startHour <= hour 的；若 hour 比所有段都小（首段未从0开始），
    // 则归到最后一段（跨午夜时段，如 23 点起的"深夜"覆盖到次日凌晨）。
    let result = periods[periods.length - 1];
    for (const p of periods) {
      if (p.startHour <= hour) result = p;
      else break;
    }
    return { name: result.name, desc: result.desc || '' };
  }

  // ===== 日期修正（day超过当月天数时自动进位） =====
  function _normalizeDate(timeObj, rules) {
    if (!timeObj) return;
    const dpm = rules.daysPerMonth || DEFAULT_RULES.daysPerMonth;
    const monthCount = dpm.length;
    // 修正day溢出
    let safety = 50; // 防死循环
    while (safety-- > 0) {
      const mIdx = ((timeObj.month - 1) % monthCount + monthCount) % monthCount;
      const maxDay = dpm[mIdx] || 30;
      if (timeObj.day <= maxDay) break;
      timeObj.day -= maxDay;
      timeObj.month++;
      if (timeObj.month > monthCount) {
        timeObj.month = 1;
        timeObj.year++;
      }
    }
    // 修正month溢出
    while (timeObj.month > monthCount) {
      timeObj.month -= monthCount;
      timeObj.year++;
    }
    while (timeObj.month < 1) {
      timeObj.month += monthCount;
      timeObj.year--;
    }
  }

  // ===== 格式化输出 =====

  /**
   * 时间对象 → 显示字符串
   * 输出格式："YYYY年M月D日 [天名] HH:mm"
   * 天名由用户自定义（如"星期一"或"水曜日"），直接显示不加前缀
   */
  function format(time, rules) {
    if (!time) return '';
    rules = getRules(rules);
    const weekDay = getWeekDay(time, rules);
    const h = String(time.hour).padStart(2, '0');
    const mi = String(time.minute).padStart(2, '0');
    return `${time.year}年${time.month}月${time.day}日 ${weekDay} ${h}:${mi}`;
  }

  // ===== 主入口：处理 AI 返回的 time 字段 =====

  /**
   * 处理 AI 输出的 time 字段，返回新的绝对时间字符串
   * 
   * @param {string} aiTimeValue - AI 输出的 time 值（可能是增量或绝对时间）
   * @param {string} currentTimeStr - 当前状态栏的时间字符串
   * @param {object} customRules - 自定义日历规则（可选）
   * @returns {object} { timeStr, timeObj, season, weekDay, isDeltaFormat }
   */
  function processTimeField(aiTimeValue, currentTimeStr, customRules) {
    const rules = getRules(customRules);

    // 情况1：增量格式
    if (isDelta(aiTimeValue)) {
      const delta = parseDelta(aiTimeValue);
      const currentTime = parseAbsoluteTime(currentTimeStr);
      if (!delta || !currentTime) {
        // 解析失败，原样返回
        const tp = currentTime ? getTimePeriod(currentTime.hour, rules) : null;
        return { timeStr: currentTimeStr, timeObj: currentTime, season: getSeason(currentTime?.month, rules), weekDay: currentTime ? getWeekDay(currentTime, rules) : '', timePeriod: tp, isDeltaFormat: true, parseError: true };
      }
      const newTime = addDelta(currentTime, delta, rules);
      const weekDay = getWeekDay(newTime, rules);
      const season = getSeason(newTime.month, rules);
      const timePeriod = getTimePeriod(newTime.hour, rules);
      return { timeStr: format(newTime, rules), timeObj: newTime, season, weekDay, timePeriod, isDeltaFormat: true };
    }

    // 情况2：绝对时间格式
    const parsed = parseAbsoluteTime(aiTimeValue);
    if (parsed) {
      // 防御：day超过当月天数时自动进位修正（兼容旧窗口AI写非法日期）
      _normalizeDate(parsed, rules);
      const weekDay = getWeekDay(parsed, rules);
      const season = getSeason(parsed.month, rules);
      const timePeriod = getTimePeriod(parsed.hour, rules);
      // 重新格式化（确保星期正确）
      return { timeStr: format(parsed, rules), timeObj: parsed, season, weekDay, timePeriod, isDeltaFormat: false };
    }

    // 情况3：无法解析，原样返回
    return { timeStr: aiTimeValue, timeObj: null, season: null, weekDay: '', timePeriod: null, isDeltaFormat: false, parseError: true };
  }

  // ===== 时间差计算 =====

  /**
   * 计算两个时间对象相差多少分钟（to - from）。可为负。
   */
  function diffMinutes(fromTime, toTime, rules) {
    if (!fromTime || !toTime) return null;
    rules = getRules(rules);
    const mph = rules.minutesPerHour;
    const hpd = rules.hoursPerDay;
    const fromTotal = _daysSinceEpoch(fromTime, rules) * hpd * mph + (fromTime.hour || 0) * mph + (fromTime.minute || 0);
    const toTotal = _daysSinceEpoch(toTime, rules) * hpd * mph + (toTime.hour || 0) * mph + (toTime.minute || 0);
    return toTotal - fromTotal;
  }

  /**
   * 把分钟数转成人类可读的间隔描述（基于自定义历法的每日小时数）。
   * 返回如 "约 3 小时"、"约 2 天"、"40 分钟左右"。
   */
  function humanizeMinutes(mins, rules) {
    rules = getRules(rules);
    const mph = rules.minutesPerHour;
    const hpd = rules.hoursPerDay;
    const sign = mins < 0 ? '-' : '';
    let m = Math.abs(Math.round(mins));
    if (m < mph) return `${sign}${m} 分钟左右`;
    const totalHours = m / mph;
    if (totalHours < hpd) {
      const h = Math.floor(totalHours);
      const rem = Math.round(m - h * mph);
      return rem >= 5 ? `${sign}约 ${h} 小时 ${rem} 分钟` : `${sign}约 ${h} 小时`;
    }
    const totalDays = totalHours / hpd;
    if (totalDays < 30) {
      const d = Math.floor(totalDays);
      const remH = Math.round(totalHours - d * hpd);
      return remH >= 1 ? `${sign}约 ${d} 天 ${remH} 小时` : `${sign}约 ${d} 天`;
    }
    return `${sign}约 ${Math.round(totalDays)} 天`;
  }

  // ===== 暴露接口 =====
  return {
    DEFAULT_RULES,
    getRules,
    parseAbsoluteTime,
    isDelta,
    parseDelta,
    addDelta,
    getWeekDay,
    getSeason,
    getTimePeriod,
    format,
    processTimeField,
    diffMinutes,
    humanizeMinutes,
    _getDaysInMonth,
    _getDaysInYear,
    _daysSinceEpoch
  };
})();
