/**
 * 🛡️ 网络诊断雷达 + ⚡️ 节点测速
 */
export default async function(ctx) {
  // 1. 统一 UI 规范颜色 (全局 C 对象)
  const C = {
    bg: { light: '#FFFFFF', dark: '#121212' },       
    barBg: { light: '#0000001A', dark: '#FFFFFF22' },
    text: { light: '#1C1C1E', dark: '#FFFFFF' },     
    dim: { light: '#8E8E93', dark: '#8E8E93' },      
    
    cpu: { light: '#007AFF', dark: '#0A84FF' },      
    mem: { light: '#AF52DE', dark: '#BF5AF2' },      
    disk: { light: '#FF9500', dark: '#FF9F0A' },     
    netRx: { light: '#34C759', dark: '#30D158' },    
    
    yellow: { light: '#FFCC00', dark: '#FFD60A' },
    red: { light: '#FF3B30', dark: '#FF453A' }
  };

  // --- 辅助与解析函数 ---
  const fmtProxyISP = (isp) => {
    if (!isp) return "未知";
    let s = String(isp);
    if (/it7/i.test(s)) return "IT7 Network";
    if (/dmit/i.test(s)) return "DMIT Network";
    if (/cloudflare/i.test(s)) return "Cloudflare";
    if (/akamai/i.test(s)) return "Akamai";
    if (/amazon|aws/i.test(s)) return "AWS";
    if (/google/i.test(s)) return "Google Cloud";
    if (/microsoft|azure/i.test(s)) return "Azure";
    if (/alibaba|aliyun/i.test(s)) return "阿里云";
    if (/tencent/i.test(s)) return "腾讯云";
    if (/oracle/i.test(s)) return "Oracle Cloud";
    return s.length > 11 ? s.substring(0, 11) + "..." : s; 
  };

  const getFlag = (code) => {
    if (!code || code.toUpperCase() === 'TW') return '🇨🇳'; 
    if (code.toUpperCase() === 'XX' || code === 'OK') return '✅';
    return String.fromCodePoint(...code.toUpperCase().split('').map(c => 127397 + c.charCodeAt()));
  };

  const BASE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
  const commonHeaders = { "User-Agent": BASE_UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8" };

  // 2. 获取本地网络数据
  const d = ctx.device || {};
  const isWifi = !!d.wifi?.ssid;
  let netName = "未连接", netIcon = "antenna.radiowaves.left.and.right";
  
  const netInfo = (typeof $network !== 'undefined') ? $network : (ctx.network || {});
  let localIp = netInfo.v4?.primaryAddress || d.ipv4?.address || "获取失败";
  let gateway = netInfo.v4?.primaryRouter || d.ipv4?.gateway || "无网关";

  if (isWifi) { netName = d.wifi.ssid; netIcon = "wifi"; }
  else if (d.cellular?.radio) {
    const radioMap = { "GPRS": "2.5G", "EDGE": "2.75G", "WCDMA": "3G", "LTE": "4G", "NR": "5G", "NRNSA": "5G" };
    netName = `${radioMap[d.cellular.radio.toUpperCase().replace(/\s+/g, "")] || d.cellular.radio}`;
    gateway = "蜂窝内网";
  }

  // 3. 基础网络请求定义
  const fetchLocal = async () => {
    try {
      const res = await ctx.http.get('https://myip.ipip.net/json', { headers: commonHeaders, timeout: 4000 });
      const body = JSON.parse(await res.text());
      if (body?.data?.ip) return { ip: body.data.ip, loc: `${body.data.location[1] || ""} ${body.data.location[2] || ""}`.trim() };
    } catch (e) {}
    return { ip: "获取失败", loc: "未知" };
  };

  const fetchProxy = async () => {
    try {
      const res = await ctx.http.get('http://ip-api.com/json/?lang=zh-CN', { timeout: 4000 });
      const data = JSON.parse(await res.text());
      const flag = getFlag(data.countryCode);
      return { ip: data.query || "获取失败", loc: `${flag} ${data.city || data.country || ""}`.trim(), isp: fmtProxyISP(data.isp || data.org), cc: data.countryCode || "XX" };
    } catch (e) { return { ip: "获取失败", loc: "未知", isp: "未知", cc: "XX" }; }
  };

  const fetchPurity = async () => {
    try {
      const res = await ctx.http.get('https://my.ippure.com/v1/info', { timeout: 4000 });
      return JSON.parse(await res.text());
    } catch (e) { return {}; }
  };

  const fetchLocalDelay = async () => {
    const start = Date.now();
    try { await ctx.http.get('http://www.baidu.com', { timeout: 2000 }); return `${Date.now() - start} ms`; } catch (e) { return "超时"; }
  };

  const fetchProxyDelay = async () => {
    const start = Date.now();
    try { await ctx.http.get('http://cp.cloudflare.com/generate_204', { timeout: 2000 }); return `${Date.now() - start} ms`; } catch (e) { return "超时"; }
  };
  
  // --- 节点测速 ---
  const fetchSpeedTest = async () => {
    const MB = 3;
    const BYTES = MB * 1024 * 1024;
    const SPEED_TEST_URL = `https://speed.cloudflare.com/__down?bytes=${BYTES}`;
    const CACHE_KEY = 'netspeed_cache';
    
    let speedData = { mbps: 0, mBs: 0, duration: 0, timestamp: Date.now() };
    
    try {
      const cached = ctx.storage.getJSON(CACHE_KEY);
      if (cached) speedData = cached;
    } catch(e) {}

    try {
      const startTime = Date.now();
      await ctx.http.get(SPEED_TEST_URL, {
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 15000 
      });
      const duration = (Date.now() - startTime) / 1000;
      const speedMBs = MB / duration;
      const speedMbps = speedMBs * 8;

      speedData = {
        mbps: parseFloat(speedMbps.toFixed(1)),
        mBs: parseFloat(speedMBs.toFixed(2)),
        duration: duration.toFixed(2),
        timestamp: Date.now()
      };
      ctx.storage.setJSON(CACHE_KEY, speedData);
    } catch(e) {}
    
    return speedData;
  };

  // 🚦 并发执行核心网络请求与测速
  const [localData, proxyData, purityData, localDelay, proxyDelay, speedData] = await Promise.all([
    fetchLocal(), fetchProxy(), fetchPurity(), fetchLocalDelay(), fetchProxyDelay(), fetchSpeedTest()
  ]);

  // 4. 数据清洗与逻辑计算
  const isRes = purityData.isResidential;
  let nativeText = "未知属性", nativeIc = "questionmark.building.fill", nativeCol = C.dim;
  if (isRes === true) { nativeText = "原生住宅"; nativeIc = "house.fill"; nativeCol = C.netRx; } 
  else if (isRes === false) { nativeText = "商业机房"; nativeIc = "building.2.fill"; nativeCol = C.disk; }

  const risk = purityData.fraudScore;
  let riskTxt = "无数据", riskCol = C.dim, riskIc = "questionmark.circle.fill";
  if (risk !== undefined) {
    if (risk >= 70) { riskTxt = `高危 (${risk})`; riskCol = C.red; riskIc = "xmark.shield.fill"; } 
    else if (risk >= 30) { riskTxt = `中危 (${risk})`; riskCol = C.disk; riskIc = "exclamationmark.triangle.fill"; } 
    else { riskTxt = `纯净 (${risk})`; riskCol = C.netRx; riskIc = "checkmark.shield.fill"; }
  }

  // 测速UI逻辑
  let speedIcon = 'tortoise';
  let speedColor = C.disk;
  if (speedData.mbps >= 50) {
    speedIcon = 'bolt.fill';
    speedColor = C.netRx;
  } else if (speedData.mbps >= 10) {
    speedIcon = 'hare.fill';
    speedColor = C.cpu;
  }
  let speedBarWidth = 30;
  if (speedData.mbps >= 80) speedBarWidth = 100;
  else if (speedData.mbps >= 50) speedBarWidth = 80;
  else if (speedData.mbps >= 20) speedBarWidth = 60;
  else if (speedData.mbps >= 10) speedBarWidth = 45;

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const TIME_COL = { light: 'rgba(0,0,0,0.3)', dark: 'rgba(255,255,255,0.3)' };

  // 5. 网格行组件 
  const Row = (ic, icCol, label, val, valCol) => ({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      { type: 'image', src: `sf-symbol:${ic}`, color: icCol, width: 11, height: 11 },
      { type: 'text', text: label, font: { size: 10, weight: 'regular' }, textColor: C.dim, maxLines: 1 }, 
      { type: 'spacer' },
      { type: 'text', text: val, font: { size: 10, weight: 'medium' }, textColor: valCol, maxLines: 1, minScale: 0.4 }
    ]
  });

  // 6. 最终渲染
  return {
    type: 'widget', 
    padding: 14, 
    backgroundColor: C.bg, 
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 5, children: [
          { type: 'image', src: 'sf-symbol:waveform.path.ecg', color: C.text, width: 13, height: 13 },
          { type: 'text', text: '网络诊断雷达', font: { size: 12, weight: 'bold' }, textColor: C.text },
          { type: 'spacer' },
          { type: 'text', text: timeStr, font: { size: 10, weight: 'medium' }, textColor: TIME_COL }
      ]},
      { type: 'spacer', length: 12 }, 
      
      // 双列网格 (雷达信息)
      { type: 'stack', direction: 'row', gap: 10, children: [
          // 【左列】：本地信息
          { type: 'stack', direction: 'column', gap: 4, flex: 1, children: [ 
              Row(netIcon, C.cpu, "环境", netName, C.text),
              Row("wifi.router.fill", C.cpu, "网关", gateway, C.text),
              Row("iphone", C.cpu, "内网", localIp, C.text),
              Row("globe.asia.australia.fill", C.cpu, "公网", localData.ip, C.text),
              Row("map.fill", C.cpu, "位置", localData.loc, C.text),
              Row("timer", C.cpu, "延迟", localDelay, C.text)
          ]},

          // ✂️ 【中轴线】
          { type: 'stack', width: 0.5, backgroundColor: C.barBg },
          
          // 【右列】：代理信息 
          { type: 'stack', direction: 'column', gap: 4, flex: 1, children: [
              Row("paperplane.fill", C.mem, "出口", proxyData.ip, C.text),
              Row("mappin.and.ellipse", C.mem, "落地", proxyData.loc, C.text),
              Row("server.rack", C.mem, "厂商", proxyData.isp, C.text),
              Row(nativeIc, nativeCol, "属性", nativeText, C.text), 
              Row(riskIc, riskCol, "纯净", riskTxt, riskCol),
              Row("timer", C.mem, "延迟", proxyDelay, C.text)
          ]}
      ]},
      
      { type: 'spacer', length: 7 },
      // ✂️ 【横向分割线】
      { type: 'stack', height: 0.5, backgroundColor: C.barBg },
      { type: 'spacer', length: 7 },

      // 底部: 测速结果
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          { type: 'image', src: `sf-symbol:${speedIcon}`, color: speedColor, width: 13, height: 13 },
          { type: 'text', text: `${speedData.mbps} Mbps`, font: { size: 13, weight: 'bold' }, textColor: speedColor }, 
          { type: 'spacer' },
          { type: 'stack', width: speedBarWidth, height: 4, backgroundColor: speedColor, cornerRadius: 2 },
          { type: 'spacer' },
          { type: 'text', text: `${speedData.mBs} MB/s`, font: { size: 11, weight: 'medium' }, textColor: C.text },
          { type: 'text', text: `  ${speedData.duration}s`, font: { size: 11 }, textColor: C.dim }
        ]
      }
    ]
  };
}
