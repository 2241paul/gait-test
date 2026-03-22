// 全局实例
const sensorManager = new SensorManager();
const gaitAnalyzer = new GaitAnalyzer();

// 状态变量
let isTesting = false;
let countdownTimer = null;
let remainingTime = 10;

// DOM元素
const timerDisplay = document.getElementById('timerDisplay');
const statusText = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const resultsCard = document.getElementById('resultsCard');

// 结果显示元素
const stepsResult = document.getElementById('stepsResult');
const cadenceResult = document.getElementById('cadenceResult');
const cycleResult = document.getElementById('cycleResult');
const cvResult = document.getElementById('cvResult');
const swayResult = document.getElementById('swayResult');
const stabilityResult = document.getElementById('stabilityResult');
const mjoaResult = document.getElementById('mjoaResult');
const gradeResult = document.getElementById('gradeResult');

// 开始测试
async function startTest() {
    // 检查支持
    const support = sensorManager.checkSensorSupport();
    if (!support.accelerometer && !support.deviceMotion) {
        alert('您的设备不支持传感器，请使用手机浏览器打开');
        return;
    }

    // 请求权限
    const hasPermission = await sensorManager.requestPermission();
    if (!hasPermission) {
        alert('需要传感器权限才能进行测试');
        return;
    }

    // 重置UI
    resetTest(false);
    isTesting = true;
    remainingTime = 10;
    
    // 更新UI
    timerDisplay.textContent = '10';
    timerDisplay.classList.add('timer-counting');
    statusText.textContent = '正在采集数据...';
    startBtn.style.display = 'none';
    resetBtn.style.display = 'none';
    resultsCard.style.display = 'none';
    
    // 启动传感器
    sensorManager.startSensors();
    
    // 开始倒计时
    countdownTimer = setInterval(() => {
        remainingTime--;
        timerDisplay.textContent = remainingTime;
        
        if (remainingTime <= 0) {
            finishTest();
        }
    }, 1000);
}

// 完成测试
function finishTest() {
    // 停止倒计时
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    
    // 停止传感器
    sensorManager.stopSensors();
    
    // 获取数据并分析
    const rawData = sensorManager.getData();
    
    if (rawData.length < 50) {
        alert('采集数据太少，请重新测试，确保手机传感器正常工作');
        resetTest();
        return;
    }
    
    // 分析数据
    const result = gaitAnalyzer.analyze(rawData);
    
    // 显示结果
    displayResults(result);
    
    // 更新UI
    isTesting = false;
    timerDisplay.classList.remove('timer-counting');
    statusText.textContent = '测试完成';
    resetBtn.style.display = 'inline-block';
    resultsCard.style.display = 'block';
}

// 显示结果
function displayResults(result) {
    const params = result.params;
    const mjPred = result.mjPrediction;
    
    stepsResult.textContent = params.stepCount;
    cadenceResult.textContent = params.cadence;
    cycleResult.textContent = params.avgCycleTime;
    cvResult.textContent = params.cycleVariability;
    swayResult.textContent = params.lateralSway;
    stabilityResult.textContent = params.stabilityScore;
    mjoaResult.textContent = `${mjPred.score} (${mjPred.description})`;
    
    gradeResult.textContent = result.grade.text;
    gradeResult.className = `result-value ${result.grade.className}`;
}

// 重置测试
function resetTest(showStart = true) {
    isTesting = false;
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    sensorManager.stopSensors();
    sensorManager.clearData();
    
    remainingTime = 10;
    timerDisplay.textContent = '10';
    timerDisplay.classList.remove('timer-counting');
    statusText.textContent = '点击开始测试';
    
    if (showStart) {
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
        resultsCard.style.display = 'none';
    }
}

// 页面可见性变化处理
document.addEventListener('visibilitychange', () => {
    if (isTesting && document.hidden) {
        // 页面隐藏时继续计时，但停止UI更新不影响数据采集
        console.log('页面进入后台，继续采集...');
    }
});

// 处理屏幕方向变化
window.addEventListener('orientationchange', () => {
    // 不影响数据采集，算法与方向无关
    console.log('屏幕方向改变');
});

// 检查是否在移动端
function checkMobile() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) {
        statusText.textContent = '请使用手机浏览器打开此页面以获取传感器数据';
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
    }
}

// 初始化
window.addEventListener('load', () => {
    checkMobile();
});
