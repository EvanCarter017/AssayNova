# AssayNova website

AssayNova 的 COA 查找、检测服务与请求草稿网站。当前在本地开发，尚未上线。项目位于 `D:\Projects\assaynova`。

## 启动

需要 Node.js 24.15 或以上（原生 SQLite），无第三方依赖，无需安装。

```powershell
cd D:\Projects\assaynova
node server.mjs
```

浏览器打开 `http://127.0.0.1:4317`。也可以在 PowerShell 执行 `./start.ps1`。
端口被占用时：`node server.mjs --port=4318`。按 Ctrl+C 停止服务。

## 实时预览

```powershell
cd D:\Projects\assaynova
node server.mjs --watch
```

或执行 `./dev.ps1`（有 npm 时也可用 `npm run dev`）。地址仍是 `http://127.0.0.1:4317`。
修改 `dist/` 下的 CSS 会立即替换样式，保留当前页面和表单；修改 HTML、JS 或图片会自动刷新页面。
开发脚本仅在 `--watch` 模式下注入，普通启动不启用。

## 局域网预览

仅需静态预览时，保留本机 4317，另开一个关闭账户功能且不带开发工具的局域网服务。完整账户与管理功能使用下方的双进程启动命令：

```powershell
node server.mjs --host=0.0.0.0 --port=4318 --no-accounts
```

同一局域网的其他设备访问 `http://电脑的IPv4地址:4318`。例如先在 Windows 网络设置中查看当前以太网或 Wi-Fi 的 IPv4 地址。该实例不加 `--watch`，不会注入元素选取器、源码上下文或开发事件流；更新文件后刷新页面即可。默认不传 `--host` 时仍只监听 `127.0.0.1`。显式绑定只接受 IPv4/IPv6 地址，不解析主机名。

## 开发元素选取与修改提示词

以 `node server.mjs --watch` 启动后，按住 **Alt** 并移动鼠标，可看到元素轮廓和提示；**Alt + 鼠标左键** 会选取实际点击的元素（包括文字 span、图标和 SVG），复制一份中文修改提示词。该手势不会触发按钮、导航或表单操作；正常点击仍保留原有交互。松开 Alt、按 Escape、窗口失焦或指针取消会清除选取轮廓。Escape 会取消尚未完成的选取；已经拦截的按下操作不会在松开后激活页面控件。

粘贴到 Codex 后，只需填写 `【希望修改的内容：请在这里填写】`。提示词包括唯一性已核对的选择器、直接相关的页面结构和计算样式、可能被级联覆盖的匹配样式，以及来源提示。静态 HTML 对应原始开标签行；弹窗动态内容只指向实际存在的渲染函数定义，不能当作子元素的精确模板行。元数据尚未就绪或无法映射时会明确标为不可用。源码提示在响应时生成，不改写 `dist/` 文件。

剪贴板写入只有成功后才显示“已复制”。浏览器拒绝或不支持自动复制时，会出现完整提示词文本框及“复制提示词”“全选文本”按钮，可手动复制；弹窗内选取时这些控件也放在当前原生弹窗内，保持可见并能获得焦点。提示词在浏览器本地生成，不发送到外部服务。查询参数只保留键名，不收集表单值、可编辑内容、Cookie 或浏览器存储；已知的已保存请求详情、成功页数据和请求列表区域也会遮盖。

较大的修改使用 `improve plan` 制定计划，再用 `improve execute` 交给独立执行代理，由审查代理核验差异和检查结果；微小修改先列简短计划。实施前重新查找当前源文件，实施后检查相关桌面/手机布局和受影响交互。项目仍使用原有 HTML/CSS/JS，无框架切换或新增依赖。

禁用方法：普通运行 `node server.mjs`。生产运行可以设置 `$env:NODE_ENV = 'production'`，此时即便带 `--watch` 也不启用注入、源码注解、开发路由、事件流或文件监听。开发文件位于 `dist/` 外，只通过明确列出的 `/__dev/` 路由提供；发布静态站点只使用 `dist/`。如永久移除该工具，需要同时删除 `dev/`、测试及 `dev-client.js` 中的选取器导入，并删除 `server.mjs` 中对应的开发模块路由、注解和元数据逻辑；保留普通静态服务代码。无需为生产部署执行这些删除。

## 当前功能

客户账户默认启用：`/register` 注册、`/login` 登录、`/account` 管理资料与自己的服务端请求草稿，`/recover-account` 使用恢复码重设密码。密码为 15–128 个 Unicode 字符；注册后显示 8 个一次性恢复码，请由用户妥善保存。没有邮件服务，邮箱始终未验证，也不会据此自动关联报告或后台客户。账户数据独立保存在被忽略的 `work/customer-accounts/accounts.sqlite`，与管理员密码、报告和图片无关。显式 `--no-accounts` 关闭账户 API 与入口；账户服务器不能静默退回浏览器假登录。详见 [客户账户与备份说明](docs/customer-accounts.md)。

管理后台基础页面位于 `/admin`，Reports 是首个实际模块：按产品原图生成 PDF/SVG、查看已发布记录，再通过普通 Verify COA 向客户展示。使用 `conference/start.ps1` 启动集成的本机 4317 服务，或显式传入 `--conference-reports --admin`；4317 是唯一报告写入进程及密码/会话管理进程。首次由管理员在本机页面设置一个密码，之后输入该密码解锁，无用户名或注册。客户页面没有管理入口。LAN 4318 可显式启用受限代理，让局域网设备在 `http://192.168.0.60:4318/admin` 使用相同密码登录；代理不建立第二个写入进程，且不能设置首个密码。登录页固定英文，进入 Reports 后可切换中英文。私有接口、图片和下载也受服务端会话保护。未来生产 TLS、角色、订单与客户管理另行建设。现阶段随机示例数据的说明只保留在私有管理区；清理生成数据不会移除后台页面。已忽略的 `work/report-studio` 保留原有 LC/PDF，重启不变。详见 [管理与报告模块说明](docs/conference-studio.md)。现有两个公开样例的披露保持原样。

在项目目录分别启动两个进程，使用当前机器的实际局域网 IPv4 地址：

```powershell
node server.mjs --watch --port=4317 --conference-reports --admin --admin-public-origin=http://192.168.0.60:4318
node server.mjs --host=0.0.0.0 --port=4318 --conference-reports --admin-proxy=http://127.0.0.1:4317 --admin-proxy-origin=http://192.168.0.60:4318
```

代理仅接受配置的私有 IPv4 Host 和本机 `127.0.0.1:4318`，保留原有密码、CSRF 与会话保护，并使用独立端口名的 Cookie，避免覆盖本机登录。两个代理参数必须同时提供，且要求非生产模式、`--conference-reports`，不得与 `--admin` 或 `--watch` 混用。去掉代理参数后，4318 的全部 `/admin` 路径恢复 404。此 HTTP 启动方式仅用于可信私有局域网预览；不用于生产或互联网部署。

同一组启动参数同时为客户账户建立独立代理：4317 是唯一账户数据库写入进程，4318 只转发 `/api/account`，不会打开第二份数据库。客户 Cookie 与管理员 Cookie 使用不同命名空间；两个端口的客户会话也彼此独立。生产账户需要显式 HTTPS 来源与可信 TLS 终止，不能把此局域网 HTTP 启动方式当作生产部署。

- 英文品牌首页，沿用现有的 AssayNova Logo、海军蓝与青绿色。
- 响应式布局、手机导航、服务介绍、送检步骤、FAQ。
- 原生 History API 单页导航：Home、Testing Methods、About us、Verify COA、Contact us 为独立视图。普通站内导航保留同一文档；修饰键、新标签页、下载、外链和未知路径仍由浏览器原生处理。
- COA Lookup Code 精确查询：`AN-7K9Q-2M4X` 与 `AN-8P6R-3N5Y` 分别打开不同的公开样例报告页。支持大小写和首尾空格处理，不做模糊匹配或默认首条回退。
- 独立报告页、浏览器前进/后退、打印 / 保存示例 PDF、复制当前查找码或同源报告链接；剪贴板失败时显示可全选的手动复制文本。
- 请求表单提供明确的 Account / This device 草稿保存位置。账户草稿由当前登录用户拥有；设备草稿保留原有浏览器保存、恢复与详情，不会因登录自动上传。保存草稿不等于送检或邮件发送。
- Contact us 提供本地咨询表单，配置 `hello@assaynova.com`、`reports@assaynova.com`、办公时间与响应估计。`mailto` 交给外部邮件客户端，网站表单只保存或复制草稿；[联系配置与咨询处理说明](docs/partner-demo-content.md) 记录当前行为。
- 可直接访问 `/coa/AN-7K9Q-2M4X` 或 `/coa/AN-8P6R-3N5Y` 并刷新。旧链接 `/?coa=AN-2026-0042` 仅在这个显式兼容入口识别旧报告编号，并替换为对应的规范查找码 URL。
- 键盘操作、焦点管理、减少动态效果的系统偏好支持。
- 未实现用户参考图中的价格动画，遵循用户最新要求。

## 样例记录与当前边界

公开样例 COA 在报告级别标为 “Sample report”，并保留简短的非有效证书说明；样例数据不代表真实签发记录。

COA Lookup Code 与报告编号、送检请求编号是不同的标识。普通查找只接受精确匹配的、已发布的查找码；空白、未知、格式错误、未发布或重复歧义的查找码不会返回报告。两个固定的虚构样例：

| COA Lookup Code | 报告编号 | 样品 | 规范路径 |
| --- | --- | --- | --- |
| `AN-7K9Q-2M4X` | `AN-2026-0042` | Reference sample A | `/coa/AN-7K9Q-2M4X` |
| `AN-8P6R-3N5Y` | `AN-2026-0043` | Reference sample C | `/coa/AN-8P6R-3N5Y` |

每个报告的样品、批次、日期、结果、保留时间、版本和发布状态均绑定所选记录。身份结果使用明确的 outcome：匹配时显示确认标记，部分匹配使用中性色/琥珀色且不显示成功勾选。曲线明确标为共用示意图，不是该报告的实测图谱。

报告页重新查找失败会清除当前报告及复制/打印控件，进入相应的未找到 URL；格式错误或空白输入使用固定的 `/coa/not-found`，不把原始输入拼进路径。刷新和浏览器前进/后退保持同样的结果。Verify COA 页查找失败保留行内提示。未知 `/coa/<查找码>` 地址返回 HTTP 404 和可恢复的页面外壳；缺失图片、脚本和无关路径继续返回普通 404。服务器仅为明确列出的页面及单个 COA 路径段提供页面路由，不提供任意文件读取或通配站点回退。

## 页面与兼容链接

| 路径 | 独立视图 |
| --- | --- |
| `/` | Home：品牌介绍、流程、公开样例报告与 FAQ |
| `/testing-methods` | 完整检测服务与请求草稿入口 |
| `/about` | 现有服务介绍与报告访问说明 |
| `/verify` | 完整 COA Lookup Code 查找表单 |
| `/contact` | 姓名、邮箱、主题、留言咨询表单；显式保存/复制/恢复/清除本地草稿，联系信息与请求/报告恢复/查询快捷入口 |
| `/submit-sample` | 三步独立请求页：检测与样品、联系与报告要求、复核后保存本地草稿 |
| `/account` | 账户资料、密码、安全与自己的请求草稿 |
| `/login`、`/register`、`/recover-account` | 登录、注册与一次性恢复码重设密码 |

这些路径均支持直接打开、刷新、前进/后退与 GET/HEAD。末尾斜杠在客户端归一化；重复选择当前页面不会新增历史记录。常规导航更新页面标题、可见视图和两个导航菜单的 `aria-current`，并聚焦新页面标题；前进/后退不强制滚到顶部，保留浏览器默认滚动恢复。

旧 `/#testing`、`/#verify` 会转到 `/testing-methods`、`/verify`，旧链接点击只增加一个规范历史条目。`/#process` 仍定位首页流程，`#main` 跳过导航链接保持原生行为。有效的旧 `/?coa=报告编号` 进入对应 COA；未知旧编号进入 Verify COA 并显示提示。请求入口进入 `/submit-sample`；Saved drafts 与 Nova Support 仍使用弹窗。History 导航关闭旧弹窗，隐私控制器在页面切换中保留单一实例和既有选择。

页面白名单位于 `dist/routes.js`，浏览器与本地服务器共用。将来增加页面需同步维护视图、标题、导航和 HTTP 测试；实际部署托管需配置同样精确的路径重写与 404 状态规则。当前使用原生 Node HTTP、SQLite 与浏览器模块，没有框架或第三方路由依赖。

当前固定报告内容是公开的虚构样例，不是有效检测报告。设备草稿保存在当前浏览器的 localStorage（最多 50 条），账户草稿显式保存在登录用户的服务端空间（最多 50 条）；两者都不会发送给实验室。新草稿引用使用 `AN-REQ-*`；保留既有存储键和旧 `AN-DEMO-*` 草稿，不清空旧记录。Version 2 草稿支持 1–10 个样品条目，每条计划数量 1–100；保存后可 Resume editing 并更新原引用。产品图偏好会保存，本地图片预览不上传、不保存文件、文件名或 blob URL。输入和页面导航不自动保存。

设备 Saved drafts 只列出本浏览器保存的记录；My account 列出当前账户自己的服务端草稿，两者不会自动合并，也没有由邮箱匹配出的私人报告列表。Contact us 的咨询草稿只在显式 Save draft 后写入 `assaynova.contact.enquiry.v1`，Copy message 不保存，Restore 仅在点击时读取，Clear 只清除该键并保留当前输入。静态 mailto 链接使用配置的 AssayNova.com 联系地址，与草稿或站内请求交付无关。邮件服务与送检投递仍未实现；后续接入边界见 `docs/email-notifications.md`。

本站面向 AssayNova。当前样例记录不构成身份验证、签发或访问控制后端；真实报告需在服务端查询实际已发布记录，并明确修订、撤回等状态。后续接入实际资料时应保持已分配查找码稳定。

当前账户与数据库用于身份和请求草稿，不包含支付、样品物流或实验室系统接入。服务范围、样品要求、报价、时效和实验室资质仍需以实际资料确认；页面不把保存草稿描述为已提交实验室。联系地址、办公时间与响应估计作为站点配置维护，详见[联系配置与咨询处理说明](docs/partner-demo-content.md)；配置地址不代表网站已启用邮件投递。

## 文件

```text
dist/index.html     页面结构
dist/styles.css     响应式样式
dist/app.js         表单、弹窗、本机草稿与公开报告交互
dist/data.js        样例报告、查找和请求校验
dist/routes.js      浏览器与服务器共用的明确页面白名单
dist/assets/        现有品牌图片
server.mjs          零依赖 HTTP、账户与公开页面入口
accounts/           客户账户、SQLite 与独立局域网账户代理
scripts/account-backup.mjs  原生 SQLite 一致性备份
start.ps1           PowerShell 启动入口
docs/email-notifications.md  本机草稿、静态联系链接与后续邮件设计边界
docs/partner-demo-content.md 联系配置与咨询处理说明
```

直接编辑 `dist/` 后刷新页面即可。服务默认仅监听本机 `127.0.0.1`；局域网监听需要显式传入 `--host`。

## 检查

```powershell
node --check server.mjs
node --check dist/app.js
node --check dist/data.js
node --check dist/routes.js
node --check dev-client.js
node --check dev/locator.js
node --check dev/prompt.js
node --check dev/context.mjs
node --test tests/*.test.mjs
```

测试使用 Node 内置测试运行器，不需要 npm 或第三方依赖；`package.json` 的 `test` 命令通过通配符覆盖现有全部测试文件。HTTP 测试在临时副本和随机本机端口运行，不会改写当前项目或占用 4317。浏览器验收另行检查联系邮箱校验、本机草稿、静态联系信息与草稿未发送说明、两个查找码对应的不同记录、URL/刷新/历史、未知码恢复、复制与打印、桌面/手机布局、Alt 源码提示和原有弹窗交互。

本轮为本地开发预览，没有注册或部署托管网站。
