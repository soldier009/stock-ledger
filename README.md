# 股票记账本

单机股票记账软件（PWA）：支持持仓管理、交易记录、盈亏分析、报表导出（Excel/PDF）、多券商资金账户、GitHub 私有仓库云备份。

## 在线访问

**生产环境（CloudBase 静态托管）**

```
https://stock-ledger-d0ghy7wiia67bb112-1301186596.tcloudbaseapp.com/
```

手机端：浏览器打开上述网址 → 「添加到主屏幕」即可全屏使用（PWA 支持离线缓存）。

## CloudBase 资源

| 项目 | 值 |
| --- | --- |
| 环境 ID | `stock-ledger-d0ghy7wiia67bb112` |
| 环境别名 | `stock-ledger` |
| 区域 | `ap-shanghai` |
| 套餐 | 体验版（baas_trial） |
| 静态托管域名 | `stock-ledger-d0ghy7wiia67bb112-1301186596.tcloudbaseapp.com` |
| 存储桶 | `0077-static-stock-ledger-d0ghy7wiia67bb112-1301186596` |
| 索引文档 | `index.html` |

## 本地开发

```bash
npm install
npm run dev      # 本地开发
npm run build    # 构建到 dist/
npm run preview  # 本地预览构建产物
```

## 部署 / 更新

前端为纯静态构建，无后端服务。更新步骤：

1. `npm run build` 重新构建（输出到 `dist/`）
2. 将 `dist/` 全部内容上传到 CloudBase 静态托管根目录（覆盖旧文件）
3. 访问线上 URL 时建议追加随机参数（如 `?v=日期`）绕过 CDN 缓存

## 数据说明

- 数据保存在各设备浏览器本地（IndexedDB / SQLite，sql.js），不经过任何服务器
- 跨设备同步方式：
  - **GitHub 私有仓库多端同步**：在「设置 → 多端同步与云备份」配置仓库地址与 PAT 令牌（需 `repo` 权限）。在**每台设备**上填入**相同的仓库地址与令牌**后，打开应用或切回前台会自动同步（云端更新 → 下载，本地更新 → 上传），手机与电脑共同使用同一份数据
  - **本地备份文件**：「设置 → 下载本地备份（.db）」→ 另一台设备「导入备份文件」，用于手动迁移或存档
