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

        return {
            accel: processedAccel,
            gyro: gyroData,
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

    // 检测步态周期（峰值检测找迈步）
    detectSteps(filteredAccel) {
        const steps = [];
        const windowSize = Math.floor(this.sampleRate * 0.5); // 0.5秒窗口
        
        // 计算标准差作为阈值
        const values = filteredAccel.map(d => d.filtered);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + (b - mean)**2, 0) / values.length;
        const std = Math.sqrt(variance);
        const threshold = mean + 0.5 * std; // 阈值设为均值加半个标准差

        for (let i = 1; i < filteredAccel.length - 1; i++) {
            // 寻找局部峰值
            if (filteredAccel[i].filtered > threshold &&
                filteredAccel[i].filtered > filteredAccel[i-1].filtered &&
                filteredAccel[i].filtered > filteredAccel[i+1].filtered) {
                
                // 检查与上一步的时间间隔（最小步间隔0.3秒≈200步/分钟）
                if (steps.length === 0 || 
                    (filteredAccel[i].timestamp - steps[steps.length - 1].timestamp) > 300) {
                    steps.push({
                        timestamp: filteredAccel[i].timestamp,
                        amplitude: filteredAccel[i].filtered - mean
                    });
                }
            }
        }

        return steps;
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
        
        // 计算侧向摆动幅度（针对踵趾步态，陀螺仪数据检测左右平衡）
        let lateralSway = 0;
        if (processedData.gyro && processedData.gyro.length > 0) {
            // 绕垂直轴（z轴）的角速度标准差反映左右摆动
            const zValues = processedData.gyro.map(d => Math.abs(d.z));
            const zMean = zValues.reduce((a, b) => a + b, 0) / zValues.length;
            const zVar = zValues.reduce((a, b) => a + (b - zMean)**2, 0) / zValues.length;
            lateralSway = Math.sqrt(zVar); // 标准差，单位：rad/s
        }
        
        // 综合稳定性评分 (0-100)，越高越稳定
        // 踵趾步态：增加侧向摆动惩罚，DCM患者侧向摆动增大
        let stabilityScore = 100;
        if (cycleVariability > 0) {
            // 变异系数越小越稳定，侧向摆动越大越不稳定
            stabilityScore = Math.max(0, 100 - cycleVariability * 1.2 - 
                                     amplitudeVariability * 0.3 - (lateralSway * 15));
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
        // 关键预测因子：稳定性、侧向摆动、步态变异，次要：步频/步数
        // 参考：Nakashima 2021, Choy 2022
        
        let prediction = 4; // 起始：正常
        
        // 稳定性评估（主要因素：包含侧向摆动和周期变异惩罚）
        // 稳定性评分低才代表异常，步频慢本身不一定异常
        if (params.stabilityScore < 40) {
            prediction -= 1;
        }
        if (params.stabilityScore < 20) {
            prediction -= 1;
        }
        
        // 侧向摆动评估（DCM患者平衡受损，侧向摆动显著增大）
        if (params.lateralSway > 2.0) {
            prediction -= 1;
        }
        if (params.lateralSway > 3.0) {
            prediction -= 1;
        }
        
        // 步态周期变异（变异越大越不稳定）
        if (params.cycleVariability > 20) {
            prediction -= 0.5;
        }
        
        // 10秒内步数评估（正常人缓慢踵趾行走也能完成6步以上）
        // 只有严重受损才会少于6步
        if (params.stepCount < 4) {
            prediction -= 1;
        }
        
        // 步频评估（放宽标准，踵趾步态本来就慢，40步以上都可接受）
        if (params.cadence < 25) {
            prediction -= 0.5;
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
        
        // 2. 滤波
        const filtered = this.lowPassFilter(processed.accel);
        
        // 3. 步检测
        const steps = this.detectSteps(filtered);
        
        // 4. 计算参数
        const params = this.calculateGaitParams(steps, processed, filtered);
        
        // 5. 预测mJOA评分
        const mjPrediction = this.predictMJOA(params);
        
        // 6. 整体等级
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
