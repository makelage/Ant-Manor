let { config } = require('../config.js')(runtime, global)
let singletonRequire = require('./SingletonRequirer.js')(runtime, global)
let FloatyInstance = singletonRequire('FloatyUtil')
let logFloaty = singletonRequire('LogFloaty')
try {
  importPackage(Packages["okhttp3"])
} catch (e) {
  //
}
try {
  importClass("okhttp3.OkHttpClient")
  importClass("okhttp3.FormBody")
  importClass("okhttp3.MediaType")
  importClass("okhttp3.RequestBody")
  importClass("okhttp3.Request")
} catch (e) {
  //
}


function inspectAnswer (content, answers) {
  if (!content) {
    return null
  }
  content = content.replace(/[\r\n]/g, '')
  let regex = /.*<answer>(\d+)<\/answer>(.*<describe>)(.*)<\/describe>/
  let match = regex.exec(content)
  if (match && match.length > 1) {
    console.verbose('答案解析：', JSON.stringify(match))
    let answerIdx = parseInt(match[1]) - 1
    let valid = true
    if (answerIdx < 0 || answerIdx > answers.length - 1) {
      valid = false
      logFloaty.pushErrorLog('傻逼AI，没有按规则回答，无法正确解析 尝试自动纠正，如失败请手动答题')
      for (let tryIdx = 0; tryIdx < answers.length; tryIdx++) {
        if (content.indexOf(answers[tryIdx]) > -1) {
          valid = true
          answerIdx = tryIdx
        }
      }
    }
    return { valid: valid, answerIdx: answerIdx, describe: match[3] }
  } else {
    logFloaty.pushErrorLog('答案解析失败，请通过日志信息自己判断或者再次尝试')
  }
  return undefined
}

/**
 * 构建请求内容
 * @param {*} question 题目信息
 * @param {*} answers  回答选项
 * @returns 
 */
function buildRequest (question, answers) {
  let options = answers.map((answer, idx) => `${idx + 1}、${answer}`).join(' ')
  let content = `${question} 选项：${options} 请严格按照以下规则先回答答案选项的顺序号：1到${answers.length}，然后再附加解释信息。
   回答时按如下结构返回：<answer>1</answer><describe>xxxx</describe>`
  console.verbose('构造请求：', content)
  return content
}

/**
 * AI接口请求：支持多接口按顺序降级
 * 1. 若配置了 API Key（kimi/chatgml/ollama），优先使用对应接口
 * 2. 配置了 ollama_cloud_api_key 时，Ollama 云端作为次选兜底
 * 3. 免费 YqCloud 接口作为最后的兜底（当前 api.binjie.fun 后端模型已下线，无 Key 时基本不可用）
 * 4. 接口返回已知失效标志（如免费接口后端模型下线）时快速失败，不再浪费重试次数，直接切换下一个接口
 */
function aiRequest (content, type, key) {
  let executors = []
  let ollamaPushed = false
  // key 统一保存在 Storages（chick_config_version_fodder.ollama_cloud_api_key），不放在 config.js 文件里；
  // 未配置时提示一次，避免静默降级到已失效的免费接口
  if (!key && !config.ollama_cloud_api_key && type === 'ollama' && !aiRequest._keyHintShown) {
    aiRequest._keyHintShown = true
    logFloaty.pushErrorLog('未配置 ollama_cloud_api_key，请执行 config.overwrite(\'fodder_config.ollama_cloud_api_key\', \'你的key\') 写入 Storages 后使用')
  }
  if (typeof key !== 'undefined' && key !== '') {
    if (type === 'kimi') {
      executors.push(new KimiRequestExecutor(key))
    } else if (type === 'chatgml') {
      executors.push(new ChatGMLRequestExecutor(key))
    } else if (type === 'ollama') {
      executors.push(new OllamaCloudRequestExecutor(key))
      ollamaPushed = true
    }
  }
  // 已配置 Ollama 云端 key 时，作为付费接口之后的次选兜底
  if (!ollamaPushed && config.ollama_cloud_api_key) {
    executors.push(new OllamaCloudRequestExecutor())
  }
  // 免费接口兜底（当前 api.binjie.fun 后端模型已下线，无 Key 时基本不可用）
  executors.push(new YqCloudRequestExecutor())
  for (let i = 0; i < executors.length; i++) {
    let executor = executors[i]
    let tryTime = 2
    while (tryTime-- > 0) {
      let result = executor.execute(content)
      if (result) {
        return result
      }
      if (executor.dead) {
        // 接口已明确失效（如 502 model not exists），不再重试，切换下一个接口
        logFloaty.pushErrorLog(executor.name + '接口已失效，尝试切换其他接口')
        break
      }
      logFloaty.pushErrorLog('接口请求失败，尝试重试[' + tryTime + ']次')
      sleep(1000)
    }
  }
}

function AiRequestExecutor () {
  this.name = 'AiRequestExecutor'
  this.dead = false
}

AiRequestExecutor.prototype.execute = function (question) {
  //
  this.dead = false
  let client = new OkHttpClient().newBuilder()
    .callTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
    .build();
  let request = this.buildRequestData(question)
  try {
    let response = client.newCall(request).execute();
    if (!response.isSuccessful()) {
      let errorBody = ''
      try {
        errorBody = response.body().string()
      } catch (e) {
        //
      }
      logFloaty.pushErrorLog(this.name + '接口请求失败，状态码：' + response.code())
      logFloaty.pushErrorLog('错误信息：' + errorBody)
      // 识别免费接口的已知失效公告，标记为失效不再重试
      if (/model not exists|接口好像出现了故障/.test(errorBody)) {
        this.dead = true
      }
      return
    }
    let responseBody = response.body().string();
    console.verbose(this.name, '请求结果', responseBody)
    return this.inspectResponse(responseBody)
  } catch (e) {
    logFloaty.pushErrorLog(this.name + '接口请求异常' + e.message)
  }
}

// openai通用结构
AiRequestExecutor.prototype.inspectResponse = function (responseBody) {
  try {
    let responseJson = JSON.parse(responseBody)
    let choices = responseJson.choices
    let content = choices[0].message.content
    return content
  } catch (e) {
    logFloaty.pushErrorLog(this.name + '接口返回数据解析失败')
    logFloaty.pushErrorLog(responseBody)
  }
}

AiRequestExecutor.prototype.buildRequestData = function (question) { }

function YqCloudRequestExecutor () {
  this.name = 'YqCloud'
}
YqCloudRequestExecutor.prototype = Object.create(AiRequestExecutor.prototype)
YqCloudRequestExecutor.prototype.constructor = YqCloudRequestExecutor

YqCloudRequestExecutor.prototype.buildRequestData = function (question) {
  logFloaty.logQueue.push('使用YqCloud接口请求,可能并不稳定', '#888888')
  let requestData = {
    "prompt": question,
    "apikey": "",
    "system": "",
    "withoutContext": false,
    "userId": 'yqcloud' + new Date().getTime(),
    "network": true
  }
  let mediaType = MediaType.parse("application/json");
  let body = RequestBody.create(mediaType, JSON.stringify(requestData));
  return new Request.Builder()
    .url("https://api.binjie.fun/api/generateStream")
    .method("POST", body)
    .addHeader("Referer", "https://chat18.aichatos.xyz")
    .addHeader("origin", "https://chat18.aichatos.xyz")
    .addHeader("User-Agent", "Apifox/1.0.0 (https://apifox.com)")
    .addHeader("Content-Type", "application/json")
    .addHeader("Accept", "*/*")
    .addHeader("Host", "api.binjie.fun")
    .addHeader("Connection", "keep-alive")
    .build();
}
// 返回结果为字符串 直接返回即可
YqCloudRequestExecutor.prototype.inspectResponse = resp => resp

function KimiRequestExecutor (key) {
  this.name = 'Kimi'
  this.key = key || config.kimi_api_key
}
KimiRequestExecutor.prototype = Object.create(AiRequestExecutor.prototype)
KimiRequestExecutor.prototype.constructor = KimiRequestExecutor
KimiRequestExecutor.prototype.buildRequestData = function (question) {
  logFloaty.logQueue.push('使用KIMI接口请求', '#888888')
  let requestData = {
    "model": "moonshot-v1-8k",
    "messages": [
      {
        "role": "system",
        "content": "你是 Kimi，由 Moonshot AI 提供的人工智能助手，你是一个答题小助手，回答时根据提示响应简短的答案，不需要附带过多的解释内容。同时，你会拒绝一些涉及恐怖主义，种族歧视，黄色暴力等问题的回答。Moonshot AI 为专有名词，不可翻译成其他语言。"
      },
      {
        "role": "user",
        "content": question
      }
    ],
    "temperature": 0.3
  }
  let mediaType = MediaType.parse("application/json");
  let body = RequestBody.create(mediaType, JSON.stringify(requestData));
  return new Request.Builder()
    .url("https://api.moonshot.cn/v1/chat/completions")
    .method("POST", body)
    .addHeader("Authorization", "Bearer " + this.key)
    .addHeader("Content-Type", "application/json")
    .addHeader("Accept", "*/*")
    .addHeader("Host", "api.moonshot.cn")
    .build();
}


function ChatGMLRequestExecutor (key) {
  this.name = 'ChatGML'
  this.key = key || config.chatgml_api_key
}
ChatGMLRequestExecutor.prototype = Object.create(AiRequestExecutor.prototype)
ChatGMLRequestExecutor.prototype.constructor = ChatGMLRequestExecutor
ChatGMLRequestExecutor.prototype.buildRequestData = function (question) {
  logFloaty.logQueue.push('使用智谱清言接口请求', '#888888')
  let requestData = {
    // glm-4-flash 为智谱免费模型，答题场景足够用；如有付费 key 可改回 glm-4
    "model": "glm-4-flash",
    "messages": [
      {
        "role": "user",
        "content": question
      }
    ]
  }
  let mediaType = MediaType.parse("application/json");
  let body = RequestBody.create(mediaType, JSON.stringify(requestData));
  return new Request.Builder()
    .url("https://open.bigmodel.cn/api/paas/v4/chat/completions")
    .method("POST", body)
    .addHeader("Authorization", "Bearer " + this.key)
    .addHeader("Content-Type", "application/json")
    .addHeader("Accept", "*/*")
    .addHeader("Host", "open.bigmodel.cn")
    .build();
}

/**
 * Ollama 云端接口（https://ollama.com）
 * 使用 Ollama 原生 /api/chat 格式（与本地 ollama 服务完全一致），Bearer 认证
 * 返回结构为 {message:{role,content,thinking},done:true,...}，与 OpenAI 的 choices 结构不同，需单独解析
 * 需要配置 ollama_cloud_api_key；模型通过 ollama_cloud_model 配置，默认 gpt-oss:120b
 */
function OllamaCloudRequestExecutor (key) {
  this.name = 'OllamaCloud'
  this.key = key || config.ollama_cloud_api_key
  this.model = config.ollama_cloud_model || 'gpt-oss:120b'
  this.url = (config.ollama_cloud_url || 'https://ollama.com').replace(/\/+$/, '') + '/api/chat'
}
OllamaCloudRequestExecutor.prototype = Object.create(AiRequestExecutor.prototype)
OllamaCloudRequestExecutor.prototype.constructor = OllamaCloudRequestExecutor

OllamaCloudRequestExecutor.prototype.buildRequestData = function (question) {
  logFloaty.logQueue.push('使用Ollama云端接口请求 模型：' + this.model, '#888888')
  let requestData = {
    "model": this.model,
    "messages": [
      {
        "role": "user",
        "content": question
      }
    ],
    "stream": false
  }
  let mediaType = MediaType.parse("application/json");
  let body = RequestBody.create(mediaType, JSON.stringify(requestData));
  return new Request.Builder()
    .url(this.url)
    .method("POST", body)
    .addHeader("Authorization", "Bearer " + this.key)
    .addHeader("Content-Type", "application/json")
    .addHeader("Accept", "*/*")
    .build();
}
// Ollama 原生返回结构：{message:{role,content,thinking},done:true,...}，非 OpenAI 的 choices 结构，需单独解析
OllamaCloudRequestExecutor.prototype.inspectResponse = function (responseBody) {
  try {
    let responseJson = JSON.parse(responseBody)
    if (responseJson.error) {
      logFloaty.pushErrorLog(this.name + '接口返回错误:' + responseJson.error)
      return
    }
    if (!responseJson.message || !responseJson.message.content) {
      logFloaty.pushErrorLog(this.name + '接口返回数据异常')
      logFloaty.pushErrorLog(responseBody)
      return
    }
    return responseJson.message.content
  } catch (e) {
    logFloaty.pushErrorLog(this.name + '接口返回数据解析失败')
    logFloaty.pushErrorLog(responseBody)
  }
}

/**
 * 查找当前答题界面的题目与选项控件
 * 兼容新版蚂蚁庄园答题界面：不再依赖固定的控件深度（旧逻辑为题目 depth17、选项 depth18），
 * 改为按几何特征查找：
 *   1. 题目为当前页面中宽度最大的长文本控件（并排除“题目来源/答答星球”等干扰项）
 *   2. 选项为位于题目下方、宽度不超过屏幕宽度 60% 的文本控件
 * 支持 2 个及以上的选项，便于后续扩展
 */
function findQuestionAndAnswers () {
  let widgets = selector().className('android.widget.TextView').find()
  let deviceWidth = (typeof device !== 'undefined' && device.width) ? device.width : 1080
  let maxAnswerWidth = deviceWidth * 0.6
  let question = null
  let all = []
  for (let i = 0; i < widgets.length; i++) {
    let widget = widgets[i]
    let text = (widget.text() || '').trim()
    if (!text) {
      continue
    }
    // 排除“题目来源 - 答答星球”等干扰文本
    if (/题目来源|答答星球/.test(text)) {
      continue
    }
    let bounds = widget.bounds()
    if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) {
      continue
    }
    let item = { widget: widget, text: text, bounds: bounds }
    all.push(item)
    if (!question || bounds.width() > question.bounds.width()) {
      question = item
    }
  }
  if (!question) {
    return { question: null, answers: [] }
  }
  let answers = all.filter(item => item.text !== question.text
    && item.bounds.top >= question.bounds.bottom
    && item.bounds.width() <= maxAnswerWidth)
  answers.sort((a, b) => a.bounds.top - b.bounds.top)
  return { question: question, answers: answers }
}

function getQuestionInfo (type, key) {
  logFloaty.pushLog('开始获取题目信息')
  FloatyInstance.setFloatyText('正在获取题目信息...')
  let questionInfo = null
  let answerInfos = []
  let t = threads.start(function () {
    let found = findQuestionAndAnswers()
    questionInfo = found.question
    answerInfos = found.answers
  })
  t.join(5000)
  t.interrupt()
  if (!questionInfo || answerInfos.length < 2) {
    logFloaty.pushErrorLog('题目信息获取失败')
    FloatyInstance.setFloatyText('题目信息获取失败')
    return
  }
  let question = questionInfo.text
  let answers = []
  let answerPosition = []
  for (let i = 0; i < answerInfos.length; i++) {
    let info = answerInfos[i]
    answers.push(info.text)
    answerPosition.push({ left: info.bounds.left, top: info.bounds.top, x: info.bounds.centerX(), y: info.bounds.centerY() })
  }
  logFloaty.pushLog(question)
  logFloaty.pushLog(JSON.stringify(answers))
  FloatyInstance.setFloatyText('请求AI接口中...')
  let start = new Date().getTime()
  let response = aiRequest(buildRequest(question, answers), type, key)
  logFloaty.pushLog('请求耗时：' + (new Date().getTime() - start) + 'ms', '#888888')
  logFloaty.pushLog('请求AI接口 答案为:' + response)
  let result = inspectAnswer(response, answers)
  if (result) {
    if (!result.valid) {
      return null
    }
    let answerWidget = answerPosition[result.answerIdx]
    let target = { x: answerWidget.x, y: answerWidget.y }
    FloatyInstance.setFloatyInfo(target, '解释信息：' + result.describe)
    logFloaty.pushLog('答案位置：' + JSON.stringify(target))
    logFloaty.pushLog('答案解释：' + result.describe)
    return { target: target, describe: result.describe }
  }
  FloatyInstance.setFloatyText('接口请求失败')
  return null
}

module.exports = {
  aiRequest,
  buildRequest,
  getQuestionInfo
}
