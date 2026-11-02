# AssayNova website prototype

本地 COA 检测平台界面雏形。项目位于 `D:\Projects\assaynova`。

## 启动

需要 Node.js 20 或以上，无第三方依赖，无需安装。

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

## 当前功能

- 英文品牌首页，沿用现有的 AssayNova Logo、海军蓝与青绿色。
- 响应式布局、手机导航、服务介绍、送检步骤、FAQ。
- COA 示例查询：`AN-2026-0042`。支持大小写和首尾空格处理、未知编号提示。
- 示例报告弹窗、打印 / 保存示例 PDF、复制报告编号。
- 送检表单校验、演示请求保存、客户门户查看请求与详情。
- 可使用 `/?coa=AN-2026-0042` 直接打开示例报告。
- 键盘操作、焦点管理、减少动态效果的系统偏好支持。
- 未实现用户参考图中的价格动画，遵循用户最新要求。

## 演示范围

所有报告内容、结果与状态均为虚构演示，不是有效检测报告。请求仅保存于当前浏览器的 localStorage（最多 50 条），不会发送给实验室。不要在演示表单中填写真实敏感信息。

当前不包含真实账户、数据库、支付、样品物流、实验室系统接入或报告签发。服务范围、样品要求、报价、时效和实验室资质均需在正式版本接入实际资料。原型不虚构这些承诺。

## 文件

```text
dist/index.html     页面结构
dist/styles.css     响应式样式
dist/app.js         表单、弹窗、门户交互
dist/data.js        演示数据与校验
dist/assets/        现有品牌图片
server.mjs          零依赖的本地静态服务器
start.ps1           PowerShell 启动入口
```

直接编辑 `dist/` 后刷新页面即可。服务仅监听本机 `127.0.0.1`。

## 检查

```powershell
node --check server.mjs
node --check dist/app.js
node --check dist/data.js
```

本轮为本地开发预览，没有注册或部署托管网站。
