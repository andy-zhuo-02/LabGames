export const TURN_SECONDS = [0, 10, 20, 30, 60, 120];
export const turnLimitLabel = (seconds) =>
  seconds === 0 ? "不限时" : `每步 ${seconds} 秒`;
