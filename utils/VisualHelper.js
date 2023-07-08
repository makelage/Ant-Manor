/*
 * @Author: TonyJiangWJ
 * @Date: 2020-11-20 16:55:08
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2023-07-05 15:46:45
 * @Description: 
 */

let { config } = require('../config.js')(runtime, global)
let sRequire = require('../lib/SingletonRequirer.js')(runtime, global)
let { debugInfo, warnInfo, errorInfo, infoLog, logInfo, debugForDev } = sRequire('LogUtils')
let commonFunction = sRequire('CommonFunction')
let CanvasDrawer = require('../lib/CanvasDrawer.js')

function VisualHelper () {
  let self = this
  this.window = null
  this.toDrawList = []
  this.drawer = null
  this.disableTips = false

  this.init = function () {
    if (!config.enable_visual_helper) {
      return
    }
    commonFunction.autoSetUpBangOffset()
    this.window = floaty.rawWindow(
      <canvas id="canvas" layout_weight="1" />
    )

    this.window.setSize(config.device_width, config.device_height)
    this.window.setTouchable(false)

    let Typeface = android.graphics.Typeface
    var paint = new Paint()
    paint.setStrokeWidth(1)
    paint.setTypeface(Typeface.DEFAULT_BOLD)
    paint.setTextAlign(Paint.Align.LEFT)
    paint.setAntiAlias(true)
    paint.setStrokeJoin(Paint.Join.ROUND)
    paint.setDither(true)
    paint.setTextSize(30)
    this.window.canvas.on("draw", function (canvas) {
      // try {
      // 清空内容
      canvas.drawColor(0xFFFFFF, android.graphics.PorterDuff.Mode.CLEAR)
      if (self.drawer == null) {
        self.drawer = new CanvasDrawer(canvas, paint, config.bang_offset)
      }

      // let canvas = new com.stardust.autojs.core.graphics.ScriptCanvas(width, height)

      !self.disableTips && self.drawer.drawText('可视化辅助工具运行中', { x: 100, y: 300 }, null, 30)
      let toDrawList = self.toDrawList
      if (toDrawList && toDrawList.length > 0) {
        toDrawList.forEach(drawInfo => {
          try {
            switch (drawInfo.type) {
              case 'rect':
                self.drawer.drawRectAndText(drawInfo.text, drawInfo.rect, drawInfo.color || '#00ff00')
                break
              case 'circle':
                self.drawer.drawCircleAndText(drawInfo.text, drawInfo.circle, drawInfo.color || '#00ff00')
                break
              case 'text':
                self.drawer.drawText(drawInfo.text, drawInfo.position, drawInfo.color || '#00ff00')
                break
              default:
                debugInfo(['no match draw event for {}', drawInfo.type], true)
            }
          } catch (e) {
            errorInfo('执行异常' + e)
            commonFunction.printExceptionStack(e)
          }
        })
      }
    })
  }

  this.disableTip = function () {
    this.disableTips = true
  }

  this.closeDialog = function () {
    if (!config.enable_visual_helper) {
      return
    }
    debugInfo('关闭悬浮窗')
    if (this.window !== null) {
      this.window.canvas.removeAllListeners()
      this.window.close()
      this.window = null
    }
  }

  this.displayAndClearAll = function (timeout) {
    if (!config.enable_visual_helper) {
      return this
    }
    timeout = timeout || 1000
    if (this.toDrawList && this.toDrawList.length > 0) {
      debugInfo(['展示所有元素并等待{}秒 总数：{}', timeout / 1000, this.toDrawList.length])
      sleep(timeout)
      this.toDrawList = []
    }
    return this
  }

  this.addRectangle = function (text, rectRegion, color) {
    if (!config.enable_visual_helper) {
      return this
    }
    if (!validRegion(rectRegion)) {
      errorInfo(['区域信息无效: {}', JSON.stringify(rectRegion)])
      return this
    }
    ui.run(function () {
      debugInfo(['添加方形区域 {} {}', text, JSON.stringify(rectRegion)])
      self.toDrawList.push({
        type: 'rect',
        text: text,
        rect: rectRegion,
        color: color,
      })
    })
    return this
  }

  this.isValidRectangle = function (r) {
    return validRegion(r)
  }

  this.addCircle = function (text, circleInfo, color) {
    if (!config.enable_visual_helper) {
      return this
    }
    ui.run(function () {
      debugInfo(['添加圆形区域 {} {}', text, JSON.stringify(circleInfo)])
      self.toDrawList.push({
        type: 'circle',
        text: text,
        circle: circleInfo,
        color: color,
      })
    })
    return this
  }

  this.addText = function (text, position, color) {
    if (!config.enable_visual_helper) {
      return this
    }
    ui.run(function () {
      debugInfo(['添加文本区域 {} {}', text, JSON.stringify(position)])
      self.toDrawList.push({
        type: 'text',
        text: text,
        position: position,
        color: color,
      })
    })
    return this
  }

}

function validRegion (region) {
  if (!region || region.length !== 4) {
    return false
  }
  if (region.filter(v => v < 0).length > 0) {
    return false
  }
  if (region[2] == 0 || region[3] == 0) {
    return false
  }
  return true
}
module.exports = VisualHelper