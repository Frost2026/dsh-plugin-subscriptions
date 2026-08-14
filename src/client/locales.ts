/** Copy dictionaries for the Subscriptions settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Subscriptions',
  intro: 'Log a subscription provider in or out. Login opens the provider’s authorization page in a new tab; headless setups can paste the callback URL or code instead.',
  unavailable: 'Connection unavailable; subscription status cannot be loaded.',
  checking: 'Checking…',
  loginInProgress: 'Login in progress…',
  loggedIn: 'Logged in',
  loggedInAccount: 'Logged in as {account}',
  loggedInExpires: 'Logged in · expires {date}',
  loggedInAccountExpires: 'Logged in as {account} · expires {date}',
  notLoggedIn: 'Not logged in',
  login: 'Log in',
  cancel: 'Cancel',
  logout: 'Log out',
  logoutConfirm: 'Log out of {provider}?',
  manualSummary: 'Browser flow not working? Paste the callback URL or code',
  manualPlaceholder: 'Paste the callback URL or code',
  submit: 'Submit',
  loginMissingUrl: 'login answered without an authorizeUrl',
  generating: 'Generating image…',
  image: 'image',
  viewImage: 'View image',
  viewImageNamed: 'View {name}',
  imageLoading: 'Loading…',
  imageLoadFailed: 'Retry',
  imagePreview: 'Image preview',
  imageClose: 'Close',
} satisfies Record<string, string>

/** zh strings, one per {@link en} key. */
export const zh = {
  nav: '订阅',
  intro: '在此登录或退出订阅服务商。点击登录会在新标签页打开服务商的授权页面；无浏览器环境可改为粘贴回调 URL 或授权码。',
  unavailable: '连接不可用，无法加载订阅状态。',
  checking: '查询中…',
  loginInProgress: '登录中…',
  loggedIn: '已登录',
  loggedInAccount: '已登录：{account}',
  loggedInExpires: '已登录 · 过期时间 {date}',
  loggedInAccountExpires: '已登录：{account} · 过期时间 {date}',
  notLoggedIn: '未登录',
  login: '登录',
  cancel: '取消',
  logout: '退出登录',
  logoutConfirm: '确定退出 {provider} 的登录吗？',
  manualSummary: '浏览器流程无法完成？粘贴回调 URL 或授权码',
  manualPlaceholder: '粘贴回调 URL 或授权码',
  submit: '提交',
  loginMissingUrl: 'login 响应缺少 authorizeUrl',
  generating: '正在生成图片…',
  image: '图片',
  viewImage: '查看图片',
  viewImageNamed: '查看 {name}',
  imageLoading: '加载中…',
  imageLoadFailed: '重试',
  imagePreview: '图片预览',
  imageClose: '关闭',
} satisfies Record<keyof typeof en, string>

/** The Subscriptions namespace key union (en is the key-set source of truth). */
export type SubscriptionsKey = keyof typeof en
