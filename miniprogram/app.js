// app.js —— 小程序入口
// 说明：此小程序用 web-view 加载 H5，复用 100% 的前端代码与体验。
// 任何 H5 端的更新都会立即在小程序内生效，无需重新发版。

App({
  onLaunch() {
    // 读取部署配置（pages/index/index.js 会从 globalData 读取）
    // 实际部署时，把 H5 域名换为你已 HTTPS 化的服务器地址
    this.globalData.h5Base = 'https://your-h5-host.example.com'
  }
})
