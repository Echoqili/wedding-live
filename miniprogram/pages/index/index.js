// pages/index/index.js
//
// 进入小程序后默认进入「宾客端」，可以直接签到 / 送祝福 / 摇一摇。
// 大屏端通常作为外部 H5 页面运行（不进入小程序），方便主持人在投影电脑控制。

const app = getApp()

Page({
  data: {
    h5Url: ''
  },

  onLoad() {
    const base = app.globalData.h5Base
    // 把 WebSocket 地址通过 query string 透传给 H5，让移动端走 RemoteStore
    const wsUrl = base.replace(/^https/, 'wss') + '/ws-not-used-here'
    // 实际上 server.js 把 WebSocket 挂在了 HTTP 同端口（path /），
    // 所以 ws URL 就是 base 的 ws 形式；不同部署请按实际调整。
    this.setData({
      h5Url: base + '/mobile.html?ws=' + encodeURIComponent(wsUrl)
    })
  },

  // 接收 H5 通过 postMessage 发来的消息（可选）
  onMessage(e) {
    // H5 端可以调用 wx.miniProgram.postMessage 把数据传回来
    // 例如：抽奖结果通知、我的中奖信息等
    // 这里不强制实现，留作扩展点
  },

  onShareAppMessage() {
    return {
      title: '婚礼互动 · 签到送祝福',
      path: '/pages/index/index'
    }
  }
})
