// Static admin UI text only. Importing this module performs no browser I/O.
export const LOCALE_KEY = 'assaynova.admin.locale.v1';
export const LOCALES = Object.freeze(['en', 'zh-CN']);
const text = {
  admin: ['ADMIN', '管理后台'], language: ['Admin language', '后台语言'], workspace: ['WORKSPACE', '工作区'], administration: ['Administration', '管理后台'],
  reports: ['Reports', '报告管理'], createReport: ['Create report', '创建报告'], publishedReports: ['Published reports', '已发布报告'], localAdministration: ['Local administration', '本机管理'],
  management: ['ASSAYNOVA / MANAGEMENT', 'ASSAYNOVA / 后台管理'], reportsTitle: ['Reports · AssayNova Admin', '报告管理 · AssayNova 管理后台'],
  reportsIntro: ['Create product reports and manage published snapshots.', '创建产品报告，管理已发布的报告快照。'], localWorkspace: ['Local workspace', '本机工作区'], logout: ['Log out', '退出登录'],
  synthetic: ['Synthetic data', '模拟数据'], syntheticNotice: ['Generated values are examples, not instrument measurements. Choose a product and review the full report preview before publishing. Customer reports use the normal COA experience.', '生成数值为模拟示例，并非仪器实测结果。请选择产品，发布前检查完整报告预览。客户仍使用正常的 COA 查询流程。'],
  searchLabel: ['Search products by name or SKU', '按产品名称或 SKU 搜索'], searchPlaceholder: ['e.g. TR10, BC10, sema, NAD+', '例如 TR10、BC10、sema、NAD+'], product: ['Product', '产品'],
  productHelp: ['Use a full SKU for an exact dose, or a family such as TR / SM. Only products with original photos are listed.', '输入完整 SKU 精确匹配剂量，或输入 TR / SM 等系列简称。仅列出有原始产品图的产品。'],
  selectedProduct: ['SELECTED PRODUCT', '当前产品'], chooseProduct: ['Choose a product', '请选择产品'], noProduct: ['No matching product', '没有匹配的产品'], chooseMatching: ['Choose a matching product', '请选择匹配的产品'],
  client: ['Client', '客户'], clientPlaceholder: ['Research client', '客户名称'], lot: ['Lot', '批次'], automatic: ['Automatic', '自动生成'], received: ['Received', '接收日期'], reported: ['Reported', '报告日期'],
  customer: ['Customer', '客户'], reloadProducts: ['Reload products', '重新读取产品'], customerDirectories: ['Customer directories', '客户产品目录'], addCustomer: ['Add customer', '添加客户'], editCustomer: ['Edit selected', '编辑当前客户'], customerName: ['Customer name on reports', '报告中的客户名称'], serverDirectory: ['Absolute server directory', '服务器目录绝对路径'], saveCustomer: ['Save customer', '保存客户'],
  directoryHelp: ['Use a folder on the server computer, not this browser device. Direct PNG files must include the product and dose, for example BPC-157 10mg.png.', '请输入运行服务的电脑上的目录，不是浏览器设备的目录。目录中的 PNG 文件名须包含产品及剂量，例如 BPC-157 10mg.png。'], editingCustomer: ['Editing the selected customer. Saved reports stay unchanged.', '正在编辑当前客户，已保存报告不会改变。'], addingCustomer: ['Add a saved customer and its product directory.', '添加客户及其产品目录。'],
  catalogLoading: ['Reading this customer’s products…', '正在读取该客户的产品…'], customerSaving: ['Checking the directory and saving the customer…', '正在检查目录并保存客户…'], customerSaved: ['Customer saved. Choose a product for the next report.', '客户已保存，请为下一份报告选择产品。'], catalogFallback: ['Products could not be read. Check the customer directory, then reload products.', '无法读取产品，请检查客户目录后重新读取产品。'], customerSaveFallback: ['Customer could not be saved. Check the name and server directory.', '无法保存客户，请检查名称和服务器目录。'],
  customerConfigError: ['Saved customer configuration is unavailable. Ask the server owner to check it.', '已保存的客户配置暂不可用，请联系服务器管理员检查。'], chooseCustomer: ['Choose a saved customer.', '请选择已保存的客户。'], customerNameError: ['Use a customer name with 1 to 64 printable ASCII characters.', '客户名称须为 1–64 个可打印的 ASCII 字符。'], customerDirectoryError: ['Use an absolute local directory on the server computer.', '请输入服务器电脑上的本地目录绝对路径。'], duplicateCustomer: ['A customer with that name already exists.', '已存在同名客户。'], customerLimit: ['A maximum of 32 customers can be saved.', '最多可保存 32 个客户。'], authoritativeClient: ['Client is determined by the saved customer.', '报告客户名称由已保存的客户配置决定。'],
  purity1: ['Purity replicate 1 (%)', '纯度平行样 1（%）'], purity2: ['Purity replicate 2 (%)', '纯度平行样 2（%）'],
  defaultsHint: ['Empty fields use context defaults. Purity is 99.05–99.95%; net content varies within ±2%. Each generation creates a new immutable snapshot and Lookup Code.', '留空字段使用默认值。纯度范围为 99.05–99.95%，净含量浮动范围为 ±2%。每次生成均创建独立、不可变的报告快照和查询码。'],
  previewOnly: ['Preview only', '仅预览'], publish: ['Generate & publish', '生成并发布'], skip: ['Skip to report controls', '跳转到报告操作区'],
  reportPreview: ['Report preview', '报告预览'], lastReport: ['LAST GENERATED REPORT · SAVED SNAPSHOT', '最近生成的报告 · 已保存快照'],
  publishedSnapshot: ['Published · immutable snapshot', '已发布 · 不可变快照'], privateSnapshot: ['Preview only · not available to customer lookup', '仅预览 · 客户暂不可查询'],
  copyLC: ['Copy LC', '复制查询码'], openCustomer: ['Open customer report', '打开客户报告'], downloadPDF: ['Download PDF', '下载 PDF'], manualCopy: ['Manual copy', '手动复制'],
  reviewTitle: ['Review your report here', '在此查看完整报告'], reviewIntro: ['Choose a product to preview its report.', '请选择产品以预览报告。'], reviewActions: ['Preview privately or generate and publish.', '可先私下预览，再生成并发布。'],
  reportLibrary: ['REPORT LIBRARY', '报告库'], stableCodes: ['Stable Lookup Codes · preserved across restart', '查询码保持不变 · 重启后保留'], historyEmpty: ['Published reports will stay here after restart.', '已发布报告会保存在此处，重启后仍可查看。'],
  openHistory: ['Open {name}, Lookup Code {code}', '打开 {name}，查询码 {code}'], loading: ['Loading catalog…', '正在加载产品目录…'],
  noMatches: ['No matching product or dose. Check the name / SKU, or clear the search.', '没有匹配的产品或剂量。请检查名称 / SKU，或清空搜索。'],
  selectedReady: ['Product selected. Review the full report preview before publishing.', '已选择产品。发布前请检查完整报告预览。'], chooseBelow: ['Choose a matching product below.', '请在下方选择匹配的产品。'],
  ready: ['Ready to create a report. Choose a product and review its report preview.', '可以创建报告了。请选择产品，并检查报告预览。'],
  publishing: ['Generating and publishing a complete snapshot…', '正在生成并发布完整报告快照…'], previewing: ['Generating a private preview…', '正在生成私有预览…'],
  publishedReady: ['Published. Share the Lookup Code or customer link.', '已发布。可分享查询码或客户报告链接。'], previewReady: ['Preview ready. Generate & publish creates a new Lookup Code.', '预览已就绪。点击“生成并发布”会创建新的查询码。'], copied: ['Lookup Code copied.', '查询码已复制。'],
  setupTitle: ['Set administrator password', '设置管理员密码'], loginTitle: ['Unlock administration', '登录管理后台'], unavailableTitle: ['Administration unavailable', '管理后台暂不可用'],
  setupIntro: ['Choose the administrator password for this computer. You will use it to unlock Reports.', '请为本机设置管理员密码，之后使用该密码登录报告管理。'],
  loginIntro: ['Enter the administrator password to open Reports.', '请输入管理员密码，进入报告管理。'], unavailableIntro: ['The saved administrator credential could not be opened. Ask the local owner to check its storage.', '无法读取已保存的管理员凭据，请联系本机管理员检查。'],
  passwordLabel: ['Administrator password', '管理员密码'], passwordPlaceholder: ['Enter administrator password', '请输入管理员密码'], passwordHelp: ['10–128 characters.', '长度为 10–128 个字符。'], unlock: ['Unlock admin', '登录后台'], unavailable: ['Unavailable', '暂不可用'], unlocking: ['Unlocking administration…', '正在登录管理后台…'],
  authFallback: ['Administration could not be unlocked. Please try again.', '暂时无法登录管理后台，请重试。'], generateFallback: ['The report could not be generated. Your previous report is still available.', '报告生成失败，之前的报告仍然保留，请重试。'],
  historyFallback: ['Published reports could not be loaded. Please try again.', '暂时无法加载已发布报告，请重试。'], logoutFallback: ['Logout could not be completed. Please try again.', '退出登录失败，请重试。'], sessionFallback: ['The admin session could not be loaded. Please refresh and try again.', '暂时无法加载管理会话，请刷新后重试。'],
  networkError: ['The local server could not be reached. Check that it is running and try again.', '无法连接本机服务，请确认服务正在运行后重试。'], expiredError: ['Administrator session expired. Unlock admin to continue.', '管理员会话已过期，请重新登录。'],
  passwordRejected: ['Administrator password was not accepted.', '管理员密码不正确。'], cooldownError: ['Too many attempts. Try again later.', '尝试次数过多，请稍后重试。'], authBusy: ['Another sign-in attempt is being processed. Try again shortly.', '正在处理另一项登录请求，请稍后重试。'],
  passwordBounds: ['Use a password with 10 to 128 characters (at most 512 UTF-8 bytes).', '密码须为 10–128 个字符，且不超过 512 个 UTF-8 字节。'], alreadyConfigured: ['The administrator password is already configured.', '管理员密码已设置，请使用现有密码登录。'], setupFirst: ['Set the administrator password first.', '请先设置管理员密码。'], credentialError: ['Administrator credential storage is unavailable.', '管理员凭据暂不可用，请联系本机管理员检查。'], csrfError: ['Sign-in request rejected. Refresh the page and try again.', '登录请求未通过校验，请刷新页面后重试。'],
  reportBusy: ['Another report is being generated. Wait for it to finish.', '另一份报告正在生成，请等待完成。'], isoError: ['Use a valid ISO date (YYYY-MM-DD).', '请输入有效日期，格式为 YYYY-MM-DD。'], dateOrderError: ['Reported date must be on or after received date.', '报告日期不能早于接收日期。'], purityError: ['Purity must be 99.05–99.95 with at most two decimal places.', '纯度须为 99.05–99.95，最多保留两位小数。'], asciiError: ['{field} must be short printable ASCII text.', '{field}须为简短、可打印的 ASCII 字符。'],
  rendererTimeout: ['Report rendering timed out. Try again.', '报告生成超时，请重试。'], rendererError: ['The report renderer could not complete. No new report was published.', '报告生成未完成，未发布新报告，请重试。'], uniqueLCError: ['Could not allocate a unique Lookup Code. Try again.', '暂时无法分配唯一查询码，请重试。'], selectProductError: ['Select a catalog product.', '请先选择目录中的产品。'], reportOperationError: ['Report operation failed; previous reports are preserved.', '报告操作失败，之前的报告已保留。'], requestError: ['The request could not be processed. Refresh and try again.', '请求无法处理，请刷新后重试。']
};
export const DICTIONARIES = Object.freeze(Object.fromEntries(LOCALES.map((locale, index) => [locale, Object.freeze(Object.fromEntries(Object.entries(text).map(([key, values]) => [key, values[index]])))])));

export function resolveLocale(saved, browserLanguage = '') {
  return LOCALES.includes(saved) ? saved : /^zh(?:-|$)/i.test(String(browserLanguage)) ? 'zh-CN' : 'en';
}
export function translate(locale, key, values = {}) {
  const value = DICTIONARIES[LOCALES.includes(locale) ? locale : 'en'][key];
  if (typeof value !== 'string') throw new Error('Unknown admin translation key: ' + key);
  return value.replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
}
const errors = new Map([
  ['Saved customer configuration is unavailable.', 'customerConfigError'], ['Choose a saved customer.', 'chooseCustomer'], ['Customer directory could not be read. Check the saved server directory and reload products.', 'catalogFallback'], ['Use a customer name with 1 to 64 printable ASCII characters.', 'customerNameError'], ['Use an absolute local directory on the server computer.', 'customerDirectoryError'], ['A customer with that name already exists.', 'duplicateCustomer'], ['A maximum of 32 customers can be saved.', 'customerLimit'], ['Client is determined by the saved customer.', 'authoritativeClient'], ['Supply only the saved customer, name and server directory.', 'customerSaveFallback'], ['Customer configuration could not be saved.', 'customerSaveFallback'], ['Customer configuration exceeds its size limit.', 'customerSaveFallback'],
  ['Administrator password was not accepted.', 'passwordRejected'], ['Too many attempts. Try again later.', 'cooldownError'], ['Another sign-in attempt is being processed. Try again shortly.', 'authBusy'], ['Use a password with 10 to 128 characters (at most 512 UTF-8 bytes).', 'passwordBounds'], ['The administrator password is already configured.', 'alreadyConfigured'], ['Set the administrator password first.', 'setupFirst'], ['Administrator credential storage is unavailable.', 'credentialError'], ['Sign-in request rejected.', 'csrfError'],
  ['Another report is being generated. Wait for it to finish.', 'reportBusy'], ['Use a valid ISO date.', 'isoError'], ['Reported date must be on or after received date.', 'dateOrderError'], ['Purity must be 99.05-99.95 with at most two decimal places.', 'purityError'], ['Report renderer timed out.', 'rendererTimeout'], ['Report renderer could not start.', 'rendererError'], ['Report renderer failed; no report was published.', 'rendererError'], ['Incomplete renderer output.', 'rendererError'], ['Could not allocate a unique Lookup Code.', 'uniqueLCError'], ['Select a catalog product.', 'selectProductError'], ['Report operation failed; previous reports are preserved.', 'reportOperationError'],
  ['Administrator session expired. Unlock admin to continue.', 'expiredError'], ['Failed to fetch', 'networkError'], ['fetch failed', 'networkError'], ['NetworkError when attempting to fetch resource.', 'networkError'], ['Load failed', 'networkError'], ['Unlock administration to continue.', 'expiredError'], ['Logout request rejected.', 'csrfError'], ['Run token required.', 'csrfError'], ['Use application/json.', 'requestError'], ['Request exceeds 8192 bytes.', 'requestError'], ['Supply only the administrator password.', 'requestError'], ['Sign-in request could not be processed.', 'requestError'], ['Unsupported report fields.', 'requestError'], ['Choose Preview or Generate and publish.', 'requestError']
]);
export function translateError(locale, message, fallback = 'requestError') {
  const ascii = /^(client|lot) must be short printable ASCII text\.$/.exec(String(message));
  if (ascii) return translate(locale, 'asciiError', { field: translate(locale, ascii[1]) });
  return translate(locale, errors.get(message) ?? fallback);
}

export function applyLocale(document, locale, titleKey) {
  document.documentElement.lang = locale;
  if (titleKey) document.title = translate(locale, titleKey) + (titleKey === 'reportsTitle' ? '' : ' · AssayNova ' + translate(locale, 'admin'));
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translate(locale, node.getAttribute('data-i18n'));
  for (const attribute of ['placeholder', 'aria-label', 'alt']) for (const node of document.querySelectorAll('[data-i18n-' + attribute + ']')) node.setAttribute(attribute, translate(locale, node.getAttribute('data-i18n-' + attribute)));
}
export function createAdminI18n({ storage, browserLanguage = 'en' } = {}) {
  const backend = () => typeof storage === 'function' ? storage() : storage;
  let saved; try { saved = backend()?.getItem(LOCALE_KEY); } catch {}
  let locale = resolveLocale(saved, browserLanguage);
  const listeners = new Set();
  return {
    get locale() { return locale; }, t: (key, values) => translate(locale, key, values), error: (message, fallback) => translateError(locale, message, fallback),
    apply: (document, titleKey) => applyLocale(document, locale, titleKey),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setLocale(value) { if (!LOCALES.includes(value)) return false; locale = value; try { backend()?.setItem(LOCALE_KEY, value); } catch {} for (const listener of listeners) listener(locale); return true; }
  };
}
