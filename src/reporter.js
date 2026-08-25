/**
 * Created by xieting on 2017/12/7.
 *
 * 统计上报桩。
 * 说明：本项目统计面板走后端 /v1/stats（见 server/index.js + server/public/index.html），
 * 不再上报到 webrtc.win 云统计；保留空实现，避免 worker.js 调用报错。
 * （去掉 axios 依赖后，bundle 体积随之减小）
 */

var debug = require('debug')('pear:reporter');

function noop() {}

module.exports = {

    reportTraffic : noop,

    finalyReportTraffic: noop,

    reportAbilities: noop
};



