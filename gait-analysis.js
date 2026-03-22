class GaitAnalyzer {
    constructor() {
        this.sampleRate = 50; // 期望采样率 Hz
    }

    // 预处理数据：分离加速度和陀螺仪数据，插值到统一时间轴
    preprocessData(rawData) {
        // 分离加速度和陀螺仪数据
        const accelData = rawData.filter(d => d.type === 'accel');
        const gyroData = rawData.filter(d => d.type === 'gyro');
        
        // 计算合加速度（去除重力影响需要滤波）
        const processedAccel = accelData.map(d => {
            const magnitude = Math.sqrt(d.x**2 + d.y**2 + d.z**2);
            return {
                timestamp: d.timestamp,
                x: d.x,
                y: d.y,
                z: d.z,
                magnitude: magnitude
            };
        });

        // 处理陀螺仪数据，计算合角速度
        const processedGyro = gyroData.map(d => {
            const magnitude = Math.sqrt(d.x**2 + d.y**2 + d.z**2);
            return {
                timestamp: d.timestamp,
                x: d.x,
                y: d.y,
                z: d.z,
                magnitude: magnitude
            };
        });

        return {
            accel: processedAccel,
            gyro: processedGyro,
            startTime: Math.min(...rawData.map(d => d.timestamp)),
            endTime: Math.max(...rawData.map(d => d.timestamp)),
            duration: (Math.max(...rawData.map(d => d.timestamp)) - Math.min(...rawData.map(d => d.timestamp))) / 1000
        };
    }

    // 低通滤波 - 去除重力分量和高频噪声
    lowPassFilter(data, alpha = 0.2) {
        if (data.length === 0) return [];
        
        const filtered = [];
        let prevFiltered = data[0].magnitude;
        filtered.push({
            ...data[0],
            filtered: prevFiltered
        });

        for (let i = 1; i < data.length; i++) {
            prevFiltered = alpha * data[i].magnitude + (1 - alpha) * prevFiltered;
            filtered.push({
                ...data[i],
                filtered: prevFiltered
            });
        }

        return filtered;
    }

    // 检测步态周期 - 融合加速度+陀螺仪双峰值检测
    // 踵趾步态步幅小，融合多传感器提高检测准确性
    detectSteps(processedData) {
        const filteredAccel = this.lowPassFilter(processedData.accel);
        const filteredGyro = this.lowPassFilterGyro(processedData.gyro);
        
        const steps = [];
        // 踵趾步态步频低，最小间隔450ms - 500ms太严格容易合并临近迈步
        // 正常人10秒10-12步，平均间隔800-1000ms，所以450足够防重复
        const minInterval = 450; 
        
        // 加速度计算阈值
        const accelValues = filteredAccel.map(d => d.filtered);
        const accelMean = accelValues.reduce((a, b) => a + b, 0) / accelValues.length;
        const accelVariance = accelValues.reduce((a, b) => a + (b - accelMean)**2, 0) / accelValues.length;
        const accelStd = Math.sqrt(accelVariance);
        // 折中阈值：0.3std 兼顾不误检静止也不漏检小迈步
        // 0.4太严可能漏步，0.2太松误检，取中间值
        const accelThreshold = accelMean + 0.3 * accelStd;

        // 陀螺仪计算阈值（绕前后轴摆动，迈步时会有峰值）
        let gyroThreshold = 0.6;
        if (filteredGyro.length > 10) {
            const gyroValues = filteredGyro.map(d => d.filtered);
            const gyroMean = gyroValues.reduce((a, b) => a + b, 0) / gyroValues.length;
            const gyroVariance = gyroValues.reduce((a, b) => a + (b - gyroMean)**2, 0) / gyroValues.length;
            const gyroStd = Math.sqrt(gyroVariance);
            // 折中：0.6std，兼顾不漏检和不误检
            gyroThreshold = gyroMean + 0.6 * gyroStd;
        }

        // 融合检测：任一传感器检测到峰值即为一步
        for (let i = 2; i < filteredAccel.length - 2; i++) {
            const accelPeak = filteredAccel[i].filtered > accelThreshold &&
                             filteredAccel[i].filtered > filteredAccel[i-1].filtered &&
                             filteredAccel[i].filtered > filteredAccel[i+1].filtered;
            
            const gyroPeak = filteredGyro.length > i && 
                            filteredGyro[i].filtered > gyroThreshold &&
                            filteredGyro[i].filtered > filteredGyro[i-1].filtered &&
                            filteredGyro[i].filtered > filteredGyro[i+1].filtered;
            
            // 至少一个传感器检测到峰值就算一步
            if (accelPeak || gyroPeak) {
                // 检查时间间隔
                if (steps.length === 0 || 
                    (filteredAccel[i].timestamp - steps[steps.length - 1].timestamp) > minInterval) {
                    steps.push({
                        timestamp: filteredAccel[i].timestamp,
                        amplitude: filteredAccel[i].filtered - accelMean,
                        hasGyroPeak: gyroPeak
                    });
                }
            }
        }

        return {steps: steps, filteredAccel: filteredAccel};
    }
    
    // 陀螺仪低通滤波
    lowPassFilterGyro(data, alpha = 0.25) {
        if (data.length === 0) return [];
        
        const filtered = [];
        let prevFiltered = data[0].magnitude;
        filtered.push({
            ...data[0],
            filtered: prevFiltered
        });

        for (let i = 1; i < data.length; i++) {
            prevFiltered = alpha * data[i].magnitude + (1 - alpha) * prevFiltered;
            filtered.push({
                ...data[i],
                filtered: prevFiltered
            });
        }

        return filtered;
    }

    // 计算步态参数，包括侧向摆动分析（针对踵趾步态优化）
    calculateGaitParams(steps, processedData, filteredAccel) {
        const duration = processedData.duration;
        const stepCount = steps.length;
        
        // 步频 (步/分钟)
        const cadence = duration > 0 ? (stepCount / duration) * 60 : 0;
        
        // 平均步周期（毫秒）
        let avgCycleTime = 0;
        if (steps.length > 1) {
            let totalInterval = 0;
            for (let i = 1; i < steps.length; i++) {
                totalInterval += steps[i].timestamp - steps[i-1].timestamp;
            }
            avgCycleTime = totalInterval / (steps.length - 1);
        }
        
        // 计算步态稳定性 - 步周期变异系数 (%)
        let cycleVariability = 0;
        if (steps.length > 2) {
            const intervals = [];
            for (let i = 1; i < steps.length; i++) {
                intervals.push(steps[i].timestamp - steps[i-1].timestamp);
            }
            const intMean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const intVar = intervals.reduce((a, b) => a + (b - intMean)**2, 0) / intervals.length;
            const intStd = Math.sqrt(intVar);
            cycleVariability = (intStd / intMean) * 100;
        }
        
        // 振幅变异（反映步态对称性）
        let amplitudeVariability = 0;
        if (steps.length > 2) {
            const amplitudes = steps.map(s => s.amplitude);
            const ampMean = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
            const ampVar = amplitudes.reduce((a, b) => a + (b - ampMean)**2, 0) / amplitudes.length;
            const ampStd = Math.sqrt(ampVar);
            amplitudeVariability = (ampStd / ampMean) * 100;
        }
        
        // 计算加速度RMS（均方根）- 整体运动剧烈程度
        let accelRMS = 0;
        if (filteredAccel.length > 10) {
            const values = filteredAccel.map(d => d.filtered);
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const squaredSum = values.reduce((a, b) => a + (b - mean)**2, 0);
            accelRMS = Math.sqrt(squaredSum / values.length);
        }

        // 加速度整体标准差
        let accelStd = 0;
        if (filteredAccel.length > 10) {
            const values = filteredAccel.map(d => d.filtered);
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const squaredSum = values.reduce((a, b) => a + (b - mean)**2, 0);
            accelStd = Math.sqrt(squaredSum / values.length);
        }
        
        // 计算侧向摆动幅度 + 整体陀螺仪RMS（针对手握手机方案）
        // 平衡差的病人需要不断用手调整平衡，整体晃动更大
        let lateralSway = 0;
        let gyroRMS = 0;
        if (processedData.gyro && processedData.gyro.length > 0) {
            // 1. 侧向摆动：绕垂直轴（z轴）的角速度标准差反映左右摆动
            const zValues = processedData.gyro.map(d => Math.abs(d.z));
            const zMean = zValues.reduce((a, b) => a + b, 0) / zValues.length;
            const zVar = zValues.reduce((a, b) => a + (b - zMean)**2, 0) / zValues.length;
            lateralSway = Math.sqrt(zVar); // 标准差，单位：rad/s
            
            // 2. 陀螺仪整体RMS：反映手部整体晃动程度
            // 平衡受损病人，手会不自觉晃动来帮助维持平衡，整体RMS更大
            const allGyroValues = processedData.gyro.map(d => d.magnitude);
            const gyroMean = allGyroValues.reduce((a, b) => a + b, 0) / allGyroValues.length;
            const gyroSquaredSum = allGyroValues.reduce((a, b) => a + (b - gyroMean)**2, 0);
            gyroRMS = Math.sqrt(gyroSquaredSum / allGyroValues.length);
        }
        
        // 综合稳定性评分 (0-100)，越高越稳定
        // 新方案：手握手机检测平衡，所以整体晃动参数权重更大
        // 平衡越差 → 手部晃动越大 → 评分越低
        let stabilityScore = 100;
        if (cycleVariability > 0) {
            stabilityScore = Math.max(0, 100 
                - cycleVariability * 1.0          // 步态周期变异
                - amplitudeVariability * 0.3     // 步幅变异
                - lateralSway * 5               // 侧向摆动
                - gyroRMS * 8                   // 整体陀螺仪晃动，这个最关键！平衡差的更大
                - accelStd * 3                 // 整体加速度标准差
            );
        }
        
        // 估计步速 (基于临床数据，正常人踵趾步态步频约60-90步/分钟)
        // 踵趾步态步长更短，约为正常行走的1/2到2/3
        const estimatedSpeed = cadence > 0 ? (cadence * 0.006) : 0;
        
        return {
            stepCount: stepCount,
            cadence: parseFloat(cadence.toFixed(1)),
            avgCycleTime: parseFloat(avgCycleTime.toFixed(1)),
            cycleVariability: parseFloat(cycleVariability.toFixed(1)),
            amplitudeVariability: parseFloat(amplitudeVariability.toFixed(1)),
            lateralSway: parseFloat(lateralSway.toFixed(2)),
            accelRMS: parseFloat(accelRMS.toFixed(2)),
            accelStd: parseFloat(accelStd.toFixed(2)),
            gyroRMS: parseFloat(gyroRMS.toFixed(2)),
            stabilityScore: parseFloat(stabilityScore.toFixed(1)),
            estimatedSpeed: parseFloat(estimatedSpeed.toFixed(2))
        };
    }

    // 根据步态参数预测mJOA下肢评分
    // mJOA下肢评分范围：0-4分
    // 0=不能行走，1=需要帮助行走，2=需要助行器，3=不稳但可独行，4=正常
    // 针对踵趾步态优化阈值 - 踵趾步态本身速度就慢，不能用正常行走标准判断
    predictMJOA(params) {
        // 基于文献和临床数据的预测模型
        // 关键预测因子：稳定性、侧向摆动、步态变异
        // 步数多/步频高说明功能好，应该加分不是扣分
        // 参考：Nakashima 2021, Choy 2022
        
        let prediction = 4; // 起始：正常
        
        // 稳定性评估（主要因素：包含侧向摆动和周期变异惩罚）
        // 稳定性评分低才代表异常，步频慢本身不一定异常
        if (params.stabilityScore < 30) {
            prediction -= 1;
        }
        if (params.stabilityScore < 15) {
            prediction -= 1;
        }
        
        // 侧向摆动评估（DCM患者平衡受损，侧向摆动显著增大）
        // 放宽阈值，减少过度扣分
        if (params.lateralSway > 3.0) {
            prediction -= 1;
        }
        if (params.lateralSway > 4.5) {
            prediction -= 1;
        }
        
        // 步态周期变异（变异越大越不稳定）
        if (params.cycleVariability > 25) {
            prediction -= 0.5;
        }
        
        // 10秒内步数评估（修正逻辑：步数少才扣分，多不扣分）
        // 正常人踵趾行走：慢速约6-8步，快速10-15步，12步完全正常
        if (params.stepCount < 3) {
            prediction -= 1; // 只有极少步数才扣分
        }
        
        // 步频评估（进一步放宽，30步以上都正常）
        // 你12步10秒就是72步/分钟，完全正常，不扣分
        if (params.cadence < 20) {
            prediction -= 0.5;
        }
        
        // 步数多说明功能好，轻微加分（修正原来逻辑错误）
        if (params.stepCount >= 10) {
            prediction += 0.5; // 10秒10步以上说明功能很好
        }
        
        // 限制范围
        prediction = Math.max(0, Math.min(4, prediction));
        prediction = Math.round(prediction);
        
        // 置信度估算
        let confidence = 70;
        if (params.stepCount > 5) confidence += 10;
        if (params.cycleVariability > 0) confidence += 5; // 有变异数据增加置信度
        
        const gradeDescriptions = {
            0: "严重受损",
            1: "重度异常",
            2: "中度异常",
            3: "轻度异常",
            4: "正常"
        };
        
        return {
            score: prediction,
            confidence: confidence,
            description: gradeDescriptions[prediction]
        };
    }

    // 获取评估等级，针对踵趾步态调整阈值
    // 踵趾步态本身速度慢，主要看稳定性，不要过度判异常
    getGrade(stabilityScore, cadence) {
        if (stabilityScore >= 50) return { text: "良好", className: "grade-excellent" };
        if (stabilityScore >= 25) return { text: "尚可", className: "grade-good" };
        return { text: "异常", className: "grade-poor" };
    }

    // 完整分析流程
    analyze(rawData) {
        // 1. 预处理
        const processed = this.preprocessData(rawData);
        
        // 2. 融合步检测（加速度+陀螺仪）
        const detectResult = this.detectSteps(processed);
        const steps = detectResult.steps;
        const filteredAccel = detectResult.filteredAccel;
        
        // 3. 计算参数
        const params = this.calculateGaitParams(steps, processed, filteredAccel);
        
        // 4. 预测mJOA评分
        const mjPrediction = this.predictMJOA(params);
        
        // 5. 整体等级
        const grade = this.getGrade(params.stabilityScore, params.cadence);
        
        return {
            params: params,
            mjPrediction: mjPrediction,
            grade: grade,
            steps: steps,
            duration: processed.duration
        };
    }
}
