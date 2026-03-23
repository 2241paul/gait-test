// ============================================================
// GaitOmics - 步态组学 App 主控制逻辑
// ============================================================

(function() {
    'use strict';

    // 全局实例（来自外部脚本）
    const sensorManager = new SensorManager();
    const gaitAnalyzer = new GaitAnalyzer();
    const dataExport = new DataExport();

    // 状态变量
    let isTesting = false;
    let isPreparing = false;
    let countdownTimer = null;
    let prepareTimer = null;
    let remainingTime = 10;
    let waveformInterval = null;
    let currentResult = null;
    let currentRawData = [];
    let currentTestIndex = 0; // 1, 2, 3 - 当前第几次测试

    // 三次测试结果存储
    let tripleResults = [null, null, null]; // [test1, test2, test3]

    // DOM 元素 - will be initialized after DOM load
    const $ = (id) => document.getElementById(id);
    let timerCircle, timerDisplay, statusText;
    let testBtn1, testBtn2, testBtn3, resetBtn;
    let resultsCard, waveformCard, waveformCanvas, historyCard, historyList;
    let detailParams, detailToggleText, detailToggleArrow;
    let stepsResult, balanceGradeResult;
    let ctx;
    const WAVEFORM_WINDOW = 2000; // 显示最近2秒数据
    const WAVEFORM_UPDATE_INTERVAL = 50; // 50ms更新一次

    // 延迟初始化DOM元素，等待DOM加载完成
    function initDOM() {
        timerCircle = $('timerCircle');
        timerDisplay = $('timerDisplay');
        statusText = $('statusText');
        testBtn1 = $('testBtn1');
        testBtn2 = $('testBtn2');
        testBtn3 = $('testBtn3');
        resetBtn = $('resetBtn');
        resultsCard = $('resultsCard');
        waveformCard = $('waveformCard');
        waveformCanvas = $('waveformCanvas');
        historyCard = $('historyCard');
        historyList = $('historyList');
        detailParams = $('detailParams');
        detailToggleText = $('detailToggleText');
        detailToggleArrow = $('detailToggleArrow');
        stepsResult = $('stepsResult');
        balanceGradeResult = $('balanceGradeResult');
        ctx = waveformCanvas.getContext('2d');
    }

    // ============================================================
    // 语音合成（Web Speech API）
    // ============================================================
    function speak(text) {
        try {
            if ('speechSynthesis' in window) {
                // 取消之前的语音
                speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'zh-CN';
                utterance.rate = 1.0;
                utterance.pitch = 1.0;
                speechSynthesis.speak(utterance);
            }
        } catch (e) {
            console.warn('语音合成不可用:', e);
        }
    }

    // ============================================================
    // 蜂鸣声
    // ============================================================
    function playBeep(frequency = 800, duration = 0.3) {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                const ctx = new AudioContext();
                const oscillator = ctx.createOscillator();
                const gainNode = ctx.createGain();
                oscillator.connect(gainNode);
                gainNode.connect(ctx.destination);
                oscillator.frequency.value = frequency;
                gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + duration);
            }
        } catch (e) {
            console.warn('音频不可用:', e);
        }
    }

    // 震动
    function vibrate(pattern = [200, 100, 200]) {
        try {
            if ('vibrate' in navigator) {
                navigator.vibrate(pattern);
            }
        } catch (e) {
            // 不支持震动忽略
        }
    }

    // ============================================================
    // Canvas 波形绘制
    // ============================================================
    function initCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = waveformCanvas.getBoundingClientRect();
        waveformCanvas.width = rect.width * dpr;
        waveformCanvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }

    function drawWaveform() {
        if (!sensorManager || !sensorManager.isRunning) return;

        const data = sensorManager.getData();
        const now = Date.now();
        const windowStart = now - WAVEFORM_WINDOW;

        // 获取最近窗口内的加速度数据
        const accelData = data.filter(d => d.type === 'accel' && d.timestamp >= windowStart);
        if (accelData.length < 2) return;

        const rect = waveformCanvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        // 清除画布
        ctx.clearRect(0, 0, w, h);

        // 绘制背景网格
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        // 颜色映射
        const axes = [
            { key: 'x', color: '#EF4444' },
            { key: 'y', color: '#10B981' },
            { key: 'z', color: '#3B82F6' }
        ];

        const minTime = accelData[0].timestamp;
        const maxTime = accelData[accelData.length - 1].timestamp;
        const timeRange = maxTime - minTime || 1;

        // 找出振幅范围用于缩放
        let maxAbs = 1;
        for (const d of accelData) {
            maxAbs = Math.max(maxAbs, Math.abs(d.x), Math.abs(d.y), Math.abs(d.z));
        }
        const scale = (h / 2 - 10) / maxAbs;

        // 绘制三轴
        for (const axis of axes) {
            ctx.strokeStyle = axis.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let firstPoint = true;
            for (const d of accelData) {
                const x = ((d.timestamp - minTime) / timeRange) * w;
                const y = h / 2 - d[axis.key] * scale;
                if (firstPoint) {
                    ctx.moveTo(x, y);
                    firstPoint = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
    }

    function startWaveform() {
        initCanvas();
        waveformCard.style.display = 'block';
        waveformInterval = setInterval(drawWaveform, WAVEFORM_UPDATE_INTERVAL);
    }

    function stopWaveform() {
        if (waveformInterval) {
            clearInterval(waveformInterval);
            waveformInterval = null;
        }
        waveformCard.style.display = 'none';
    }

    // ============================================================
    // 3秒准备倒计时
    // ============================================================
    function startPreparation() {
        isPreparing = true;
        let count = 3;

        timerCircle.className = 'timer-circle preparing';
        timerDisplay.textContent = count;
        timerDisplay.classList.add('timer-counting');
        statusText.textContent = '准备...';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'none';
        resultsCard.style.display = 'none';

        // 语音提示：三
        speak('三');

        prepareTimer = setInterval(() => {
            count--;
            if (count > 0) {
                timerDisplay.textContent = count;
                timerDisplay.classList.remove('timer-counting');
                void timerDisplay.offsetWidth; // 触发重绘
                timerDisplay.classList.add('timer-counting');
                // 语音
                const nums = { 2: '二', 1: '一' };
                speak(nums[count]);
            } else {
                // 准备结束，开始测试
                clearInterval(prepareTimer);
                prepareTimer = null;
                isPreparing = false;
                beginTesting();
            }
        }, 1000);
    }

    // ============================================================
    // 10秒测试阶段
    // ============================================================
    function beginTesting() {
        isTesting = true;
        remainingTime = 10;

        // 更新UI
        timerCircle.className = 'timer-circle testing';
        timerDisplay.textContent = '10';
        timerDisplay.classList.remove('timer-counting');
        void timerDisplay.offsetWidth;
        timerDisplay.classList.add('timer-counting');
        statusText.textContent = '正在进行踵趾行走...';

        // 语音提示
        speak('请开始踵趾行走，保持手机平稳');

        // 启动传感器，检查是否成功
        const started = sensorManager.startSensors();
        if (!started) {
            alert('传感器启动失败，请确保您使用的是现代手机浏览器并授予传感器权限');
            resetTestUI();
            return;
        }

        // 启动波形
        startWaveform();

        // 开始10秒倒计时
        countdownTimer = setInterval(() => {
            remainingTime--;
            timerDisplay.textContent = remainingTime;

            if (remainingTime <= 3 && remainingTime > 0) {
                // 最后3秒脉冲更明显
                playBeep(600, 0.15);
            }

            if (remainingTime <= 0) {
                finishTest();
            }
        }, 1000);
    }

    // ============================================================
    // 测试结束
    // ============================================================
    function finishTest() {
        // 停止倒计时
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }

        isTesting = false;

        // 停止传感器
        sensorManager.stopSensors();

        // 停止波形
        stopWaveform();

        // 完成效果
        timerCircle.className = 'timer-circle completed';
        timerDisplay.textContent = '\u2713'; // ✓
        timerDisplay.classList.remove('timer-counting');
        statusText.textContent = '测试完成';

        // 震动 + 蜂鸣 + 语音
        vibrate([300, 100, 300]);
        playBeep(1000, 0.4);
        speak('测试完成');

        // 获取数据
        currentRawData = sensorManager.getData();

        if (currentRawData.length < 50) {
            alert('采集数据太少，请重新测试，确保手机传感器正常工作');
            resetTestUI();
            return;
        }

        // 分析数据
        try {
            currentResult = gaitAnalyzer.analyze(currentRawData);
            displayResults(currentResult);
        } catch (e) {
            console.error('分析出错:', e);
            alert('分析出错：' + e.message);
            resetTestUI();
            return;
        }

        // 显示UI
        resultsCard.style.display = 'block';
        resetBtn.style.display = 'inline-block';

        // 保存本次结果
        tripleResults[currentTestIndex - 1] = {
            result: currentResult,
            rawData: currentRawData
        };

        // 更新三次测试表格
        updateTripleResultsTable();

        // 启用下一次测试按钮
        if (currentTestIndex < 3) {
            $(`testBtn${currentTestIndex + 1}`).disabled = false;
        }

        // 如果三次都完成，计算平均并生成最终报告
        if (currentTestIndex === 3 && tripleResults.every(r => r !== null)) {
            computeAverageAndFinalize();
        }

        // 保存单次测试历史记录（通过 DataExport 模块）
        dataExport.saveRecord({
            features: currentResult.features,
            featureCount: Object.keys(currentResult.features).length,
            mjPrediction: currentResult.mjPrediction,
            duration: currentResult.duration,
            patientInfo: getPatientInfo(),
            rawData: currentRawData // 仅用于导出，不存入 localStorage
        });

        // 显示历史记录
        renderHistory();
    }

    // ============================================================
    // 更新三次测试结果表格
    // ============================================================
    function updateTripleResultsTable() {
        for (let i = 0; i < 3; i++) {
            const row = $(`resultRow${i + 1}`);
            const result = tripleResults[i];
            if (result && result.result) {
                const features = result.result.features;
                const mj = result.result.mjPrediction;
                row.querySelectorAll('.col')[1].textContent = features.step_count || '-';
                row.querySelectorAll('.col')[2].textContent = features.step_frequency ? ((features.step_frequency * 60).toFixed(1)) : '-';
                row.querySelectorAll('.col')[3].textContent = mj ? mj.score : '-';
            }
        }
    }

    // ============================================================
    // 计算三次平均值并完成最终结果
    // ============================================================
    function computeAverageAndFinalize() {
        // 计算平均值（对数值型特征）
        const avgFeatures = {};
        const count = 3;

        // 需要平均的关键参数
        const keysToAvg = ['step_count', 'step_frequency', 'step_time_mean', 'step_time_std', 
                         'sway_area', 'sway_path_length', 'acc_total_std', 
                         'sample_entropy', 'signal_quality_score'];

        keysToAvg.forEach(key => {
            let sum = 0;
            let validCount = 0;
            tripleResults.forEach(r => {
                const val = r.result.features[key];
                if (typeof val === 'number' && isFinite(val)) {
                    sum += val;
                    validCount++;
                }
            });
            avgFeatures[key] = validCount > 0 ? sum / validCount : 0;
        });

        // 复制其他特征（使用第一次的非数值特征）
        Object.assign(avgFeatures, tripleResults[0].result.features);

        // 平均mJOA评分（四舍五入）
        let mjSum = 0;
        tripleResults.forEach(r => {
            mjSum += r.result.mjPrediction ? r.result.mjPrediction.score : 0;
        });
        const avgMjScore = Math.round(mjSum / count);
        const avgMjPrediction = {
            score: avgMjScore,
            confidence: 75,
            description: balanceGrade[avgMjScore]
        };

        // 更新平均表格
        $('avgSteps').textContent = avgFeatures.step_count ? avgFeatures.step_count.toFixed(1) : '-';
        $('avgCadence').textContent = avgFeatures.step_frequency ? (avgFeatures.step_frequency * 60).toFixed(1) : '-';
        $('avgMjOA').textContent = avgMjScore;

        // 保存最终平均结果
        currentResult.features = Object.assign({}, currentResult.features, avgFeatures);
        currentResult.mjPrediction = avgMjPrediction;

        speak('三次测试完成，结果已生成');
    }

    // 平衡等级描述映射
    const balanceGrade = {
        4: '正常',
        3: '正常',
        2: '轻度异常',
        1: '重度异常',
        0: '重度异常'
    };

    const balanceGradeClass = {
        4: 'grade-excellent',
        3: 'grade-excellent',
        2: 'grade-good',
        1: 'grade-poor',
        0: 'grade-poor'
    };

    // ============================================================
    // 显示结果
    // ============================================================
    function displayResults(result) {
        const params = result.features || result.params;
        const gaitSpecific = result.categories?.gaitSpecific || {};

        stepsResult.textContent = gaitSpecific.step_count || 0;
        const score = result.mjPrediction?.score || 0;
        balanceGradeResult.textContent = balanceGrade[score] || '-';
        balanceGradeResult.className = 'result-value ' + balanceGradeClass[score];

        // 隐藏详细参数
        detailParams.style.display = 'none';
        detailToggleArrow.classList.remove('expanded');

        // 填充详细参数
        fillDetailParams(result);
    }

    // ============================================================
    // 填充详细参数
    // ============================================================
    function fillDetailParams(result) {
        const cats = result.categories || {};
        const features = result.features || {};

        // 时域参数 - 从categories.timeDomain获取
        const timeDomain = cats.timeDomain || {};

        // 频域参数
        const freqDomain = cats.frequency || {};

        // 步态参数
        const gait = cats.gaitSpecific || {};

        // 非线性参数
        const nonlinear = cats.nonlinear || {};

        // 分段参数
        const segments = cats.timeSegment || {};

        // 质控参数
        const qc = cats.quality || {};

        renderParamGroup('timeDomainParams', timeDomain);
        renderParamGroup('freqDomainParams', freqDomain);
        renderParamGroup('gaitParams', gait);
        renderParamGroup('nonlinearParams', nonlinear);
        renderParamGroup('segmentParams', segments);
        renderParamGroup('qcParams', qc);
    }

    function renderParamGroup(containerId, paramsObj) {
        const container = $(containerId);
        if (!container) return;

        // 过滤掉 undefined 值
        const entries = Object.entries(paramsObj).filter(([k, v]) => v !== undefined);

        if (entries.length === 0) {
            container.innerHTML = '<div class="param-row"><span class="param-name">暂无数据</span></div>';
            return;
        }

        container.innerHTML = entries.map(([name, value]) => {
            const displayValue = typeof value === 'number' ? value.toFixed(4) : String(value);
            return `<div class="param-row">
                <span class="param-name" title="${name}">${name}</span>
                <span class="param-value">${displayValue}</span>
            </div>`;
        }).join('');
    }

    // ============================================================
    // 切换详细参数
    // ============================================================
    function toggleDetailParams() {
        const isHidden = detailParams.style.display === 'none';
        detailParams.style.display = isHidden ? 'block' : 'none';
        detailToggleArrow.classList.toggle('expanded', isHidden);
    }

    // 切换参数分组
    function toggleParamGroup(header) {
        const content = header.nextElementSibling;
        const arrow = header.querySelector('.param-group-arrow');
        const isExpanded = content.classList.contains('expanded');
        content.classList.toggle('expanded', !isExpanded);
        arrow.classList.toggle('expanded', !isExpanded);
    }

    // ============================================================
    // 手动校正步数
    // ============================================================
    function editSteps() {
        if (!currentResult) return;
        const gaitSpecific = currentResult.categories?.gaitSpecific || {};
        const userInput = prompt('请输入实际数出的步数：', gaitSpecific.step_count || 0);
        if (userInput === null) return;
        const newSteps = parseInt(userInput);
        if (isNaN(newSteps) || newSteps < 0) {
            alert('请输入有效数字');
            return;
        }
        // 更新参数，重新计算派生参数
        if (!currentResult.categories) currentResult.categories = {};
        if (!currentResult.categories.gaitSpecific) currentResult.categories.gaitSpecific = {};
        currentResult.categories.gaitSpecific.step_count = newSteps;
        const duration = currentResult.duration || 10;
        currentResult.categories.gaitSpecific.step_frequency = newSteps / duration;
        displayResults(currentResult);
    }

    // ============================================================
    // 获取患者信息
    // ============================================================
    function getPatientInfo() {
        return {
            name: $('patientName').value.trim(),
            gender: $('patientGender').value,
            age: $('patientAge').value.trim(),
            id: $('patientId').value.trim(),
            diagnosis: $('patientDiagnosis').value.trim()
        };
    }

    // ============================================================
    // CSV 导出（委托给 DataExport 模块）
    // ============================================================
    function exportCSV() {
        if (!currentResult) return;
        const patientInfo = getPatientInfo();
        dataExport.exportFeaturesCSV({
            features: currentResult.features,
            mjPrediction: currentResult.mjPrediction
        }, `gaitomics_${formatTimestamp(new Date())}`, patientInfo);
    }

    // ============================================================
    // 邮件发送（使用mailto协议唤起本地邮件客户端）
    // ============================================================
    function sendEmail() {
        if (!currentResult) {
            alert('请先完成测试再发送邮件');
            return;
        }
        const emailAddr = $('emailAddress').value.trim();
        if (!emailAddr || !emailAddr.includes('@')) {
            alert('请输入有效的邮箱地址');
            return;
        }

        // 生成CSV内容但不下载，用于邮件附件
        const patientInfo = getPatientInfo();
        const csvContent = dataExport.exportFeaturesCSV({
            features: currentResult.features,
            mjPrediction: currentResult.mjPrediction
        }, `gaitomics_${formatTimestamp(new Date())}`, patientInfo);

        // 构建mailto链接
        // 注意：mailto对附件大小有限制，一般几KB可以，太大无法附件
        // 所以我们把CSV内容放在正文里，收件人填写用户输入
        const patientStr = [
            patientInfo.name ? `姓名：${patientInfo.name}` : '',
            patientInfo.gender ? `性别：${patientInfo.gender}` : '',
            patientInfo.age ? `年龄：${patientInfo.age}岁` : '',
            patientInfo.id ? `住院号：${patientInfo.id}` : '',
            patientInfo.diagnosis ? `初步诊断：${patientInfo.diagnosis}` : ''
        ].filter(s => s).join('%0D%0A');

        const mjScore = currentResult.mjPrediction ? currentResult.mjPrediction.score : 'N/A';
        const mjDesc = currentResult.mjPrediction ? currentResult.mjPrediction.description : '';
        const stepCount = currentResult.features ? currentResult.features.step_count : 'N/A';
        const stepFreq = currentResult.features ? (currentResult.features.step_frequency * 60).toFixed(1) : 'N/A';

        let body = `${patientStr}%0D%0A%0D%0A`;
        body += `测试结果：%0D%0A`;
        body += `步数：${stepCount} 步%0D%0A`;
        body += `步频：${stepFreq} 步/分钟%0D%0A`;
        body += `mJOA下肢评分：${mjScore}/4 (${mjDesc})%0D%0A%0D%0A`;
        body += `完整CSV数据见附件。由于浏览器限制，如果附件没有显示，请手动复制下方CSV内容保存：%0D%0A%0D%0A`;
        body += encodeURIComponent(csvContent);

        const subject = encodeURIComponent(`GaitOmics步态分析报告 - ${patientInfo.name || '未命名'}`);
        const mailtoUrl = `mailto:${emailAddr}?subject=${subject}&body=${body}`;

        // 打开mailto链接，唤起系统默认邮件客户端
        window.location.href = mailtoUrl;
    }

    // ============================================================
    // JSON 原始数据导出（委托给 DataExport 模块）
    // ============================================================
    function exportJSON() {
        if (!currentRawData || currentRawData.length === 0) return;
        dataExport.exportRawDataJSON({
            rawData: currentRawData,
            duration: currentResult ? currentResult.duration : 0,
            samplingRate: 50,
            quality: currentResult ? { stabilityScore: currentResult.params.stabilityScore } : {}
        }, `gaitomics_raw_${formatTimestamp(new Date())}`);
    }

    function formatTimestamp(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    // ============================================================
    // 历史记录（通过 DataExport 模块管理 localStorage）
    // ============================================================

    function renderHistory() {
        const history = dataExport.getHistory();
        if (history.length === 0) {
            historyCard.style.display = 'none';
            return;
        }

        historyCard.style.display = 'block';
        // getHistory 返回按时间正序，取最近5条
        const recent = history.slice(-5).reverse();

        historyList.innerHTML = recent.map((record, index) => {
            const date = new Date(record.timestamp);
            const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            
            const mjScore = record.mjPrediction?.score || 0;
            const stepCount = record.features?.step_count || 0;
            const stepFreq = record.features?.step_frequency || 0;
            const cadence = (stepFreq * 60).toFixed(1);
            
            let scoreClass = '';
            if (mjScore >= 3) scoreClass = 'grade-excellent';
            else if (mjScore >= 2) scoreClass = 'grade-good';
            else scoreClass = 'grade-poor';

            return `<div class="history-item" onclick="app.viewHistoryDetail('${record.id}')">
                <span class="history-item-time">${timeStr}</span>
                <div class="history-item-scores">
                    <span class="history-item-score">评分 <strong class="${scoreClass}">${mjScore}</strong></span>
                    <span class="history-item-score">步频 <strong>${cadence}</strong></span>
                </div>
            </div>`;
        }).join('');
    }

    function viewHistoryDetail(id) {
        const record = dataExport.getRecordById(id);
        if (!record) return;

        const features = record.features || {};
        const mjPred = record.mjPrediction || {};
        const lines = [
            `测试时间：${new Date(record.timestamp).toLocaleString('zh-CN')}`,
            ``,
            `步数：${features.step_count || '-'} 步`,
            `步频：${((features.step_frequency || 0) * 60).toFixed(1)} 步/分钟`,
            `mJOA评分：${mjPred.score || '-'} / 4`,
            `功能描述：${mjPred.description || '-'}`,
            `置信度：${mjPred.confidence || '-'}%`,
            `特征数：${record.featureCount || 0}`
        ];

        alert(lines.join('\n'));
    }

    function clearHistory() {
        if (!confirm('确定要清除所有历史记录吗？')) return;
        dataExport.clearHistory();
        renderHistory();
    }

    // ============================================================
    // 重置单次测试（用于重新测试当前次）
    // ============================================================
    function resetTestUI() {
        isTesting = false;
        isPreparing = false;

        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        if (prepareTimer) {
            clearInterval(prepareTimer);
            prepareTimer = null;
        }

        sensorManager.stopSensors();
        sensorManager.clearData();
        stopWaveform();

        timerCircle.className = 'timer-circle';
        timerDisplay.textContent = '10';
        timerDisplay.classList.remove('timer-counting');
        statusText.textContent = `准备测试第 ${currentTestIndex} 次`;

        if (currentTestIndex === 1) testBtn1.style.display = 'inline-block';
        resetBtn.style.display = 'none';
        resultsCard.style.display = 'none';

        currentResult = null;
        currentRawData = [];
    }

    // ============================================================
    // 重置所有三次测试
    // ============================================================
    function resetAllTests() {
        tripleResults = [null, null, null];
        currentTestIndex = 1;
        if (testBtn1) testBtn1.disabled = false;
        if (testBtn2) testBtn2.disabled = true;
        if (testBtn3) testBtn3.disabled = true;

        // 清空表格
        for (let i = 0; i < 3; i++) {
            const row = $(`resultRow${i + 1}`);
            if (row) {
                row.querySelectorAll('.col')[1].textContent = '-';
                row.querySelectorAll('.col')[2].textContent = '-';
                row.querySelectorAll('.col')[3].textContent = '-';
            }
        }
        if ($('avgSteps')) $('avgSteps').textContent = '-';
        if ($('avgCadence')) $('avgCadence').textContent = '-';
        if ($('avgMjOA')) $('avgMjOA').textContent = '-';

        resetTestUI();
    }

    function resetTest() {
        resetTestUI();
    }

    // ============================================================
    // 开始测试
    // ============================================================
    async function startTest(testIndex = 1) {
        currentTestIndex = testIndex;
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

        // 重置状态
        resetTestUI();

        // 开始3秒准备倒计时
        startPreparation();
    }

    // ============================================================
    // 移动端检测
    // ============================================================
    function checkMobile() {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (!isMobile) {
            statusText.textContent = '请使用手机浏览器打开此页面以获取传感器数据';
            // 禁用三个测试按钮
            if (testBtn1) testBtn1.disabled = true;
            if (testBtn2) testBtn2.disabled = true;
            if (testBtn3) testBtn3.disabled = true;
            if (testBtn1) testBtn1.style.opacity = '0.5';
            if (testBtn2) testBtn2.style.opacity = '0.5';
            if (testBtn3) testBtn3.style.opacity = '0.5';
        }
    }

    // ============================================================
    // 页面可见性处理
    // ============================================================
    document.addEventListener('visibilitychange', () => {
        if ((isTesting || isPreparing) && document.hidden) {
            console.log('页面进入后台，继续采集...');
        }
    });

    window.addEventListener('orientationchange', () => {
        console.log('屏幕方向改变');
        if (waveformCard.style.display !== 'none') {
            initCanvas();
        }
    });

    // ============================================================
    // 初始化
    // ============================================================
    window.addEventListener('load', () => {
        initDOM();
        checkMobile();
        renderHistory();
    });

    // ============================================================
    // 公开接口（挂载到全局，供HTML onclick调用）
    // ============================================================
    window.app = {
        startTest,
        resetTest,
        resetAllTests,
        editSteps,
        toggleDetailParams,
        toggleParamGroup,
        exportCSV,
        exportJSON,
        sendEmail,
        viewHistoryDetail,
        clearHistory
    };

})();
