/**
 * GaitAnalyzer - 步态特征提取引擎
 * 从传感器原始数据提取147+个步态特征参数，分为7大类
 */
class GaitAnalyzer {
    constructor() {
        this.targetSampleRate = 100; // Hz
    }

    // ====== 主分析入口 ======

    /**
     * 完整分析流程
     * @param {Array} rawData - SensorManager输出的标准化数据
     * @returns {Object} 完整分析结果
     */
    analyze(rawData) {
        // 1. 预处理：分离数据流 + 预滤波
        const processed = this._preprocessData(rawData);

        // 2. 步态事件检测（用原始rawData，步检测有自己的带通滤波链，不依赖预滤波）
        const stepDetection = this._detectStepsFromRaw(rawData);

        // 3. 提取所有特征（7大类）
        const timeDomain = this._extractTimeDomain(processed);
        const axial = this._extractAxialDecomposition(processed);
        const frequency = this._extractFrequencyDomain(processed);
        const gaitSpecific = this._extractGaitSpecific(processed, stepDetection);
        const nonlinear = this._extractNonlinearDynamics(processed);
        const timeSegment = this._extractTimeSegmentation(processed);
        const quality = this._extractQualityParams(rawData, processed);

        // 4. mJOA预测
        const mjPrediction = this._predictMJOA(gaitSpecific, timeDomain, quality);

        // 5. 整合所有特征
        const allFeatures = {
            ...timeDomain,
            ...axial,
            ...frequency,
            ...gaitSpecific,
            ...nonlinear,
            ...timeSegment,
            ...quality
        };

        return {
            features: allFeatures,
            featureCount: Object.keys(allFeatures).length,
            categories: {
                timeDomain,
                axial,
                frequency,
                gaitSpecific,
                nonlinear,
                timeSegment,
                quality
            },
            mjPrediction,
            steps: stepDetection.steps,
            duration: processed.duration,
            stepDetection
        };
    }

    // ====== 1. 预处理 ======

    _preprocessData(rawData) {
        const accelData = rawData.filter(d => d.type === 'accel');
        const gyroData = rawData.filter(d => d.type === 'gyro');

        // ── V1.1: 预滤波流程 ──
        // 步态信号有效频率成分在 0.5~10Hz 范围内，
        // 10Hz以上的高频成分为传感器电子噪声/手指抖动，需去除。
        // 预滤波仅作用于后续特征提取的副本数据，不影响步检测（步检测有自己的滤波链）。
        const PRE_FILTER_CUTOFF = 10; // Hz — 二阶Butterworth低通截止频率

        // 对加速度三轴分别做：中值滤波(3pt) → 低通滤波(10Hz)
        const filterAxis = (data, axis) => {
            const raw = data.map(d => d[axis]);
            const medfilt = this._medianFilter3(raw);
            return this._butterLowPass(medfilt, PRE_FILTER_CUTOFF, this.targetSampleRate);
        };
        const accX = accelData.length > 0 ? filterAxis(accelData, 'x') : [];
        const accY = accelData.length > 0 ? filterAxis(accelData, 'y') : [];
        const accZ = accelData.length > 0 ? filterAxis(accelData, 'z') : [];

        const gyrX = gyroData.length > 0 ? filterAxis(gyroData, 'x') : [];
        const gyrY = gyroData.length > 0 ? filterAxis(gyroData, 'y') : [];
        const gyrZ = gyroData.length > 0 ? filterAxis(gyroData, 'z') : [];

        // 计算矢量模（基于滤波后的数据）
        const processedAccel = accelData.map((d, i) => ({
            ...d,
            x: accX[i] !== undefined ? accX[i] : d.x,
            y: accY[i] !== undefined ? accY[i] : d.y,
            z: accZ[i] !== undefined ? accZ[i] : d.z,
            total: Math.sqrt(
                (accX[i] !== undefined ? accX[i] : d.x) ** 2 +
                (accY[i] !== undefined ? accY[i] : d.y) ** 2 +
                (accZ[i] !== undefined ? accZ[i] : d.z) ** 2
            )
        }));

        const processedGyro = gyroData.map((d, i) => ({
            ...d,
            x: gyrX[i] !== undefined ? gyrX[i] : d.x,
            y: gyrY[i] !== undefined ? gyrY[i] : d.y,
            z: gyrZ[i] !== undefined ? gyrZ[i] : d.z,
            total: Math.sqrt(
                (gyrX[i] !== undefined ? gyrX[i] : d.x) ** 2 +
                (gyrY[i] !== undefined ? gyrY[i] : d.y) ** 2 +
                (gyrZ[i] !== undefined ? gyrZ[i] : d.z) ** 2
            )
        }));

        const allTimestamps = rawData.map(d => d.timestamp);
        const startTime = Math.min(...allTimestamps);
        const endTime = Math.max(...allTimestamps);

        return {
            accel: processedAccel,
            gyro: processedGyro,
            raw: rawData,
            startTime,
            endTime,
            duration: (endTime - startTime) / 1000
        };
    }

    // ====== 2. 步态事件检测（加速度+陀螺仪双传感器融合）======

    _detectStepsFromRaw(rawData) {
        const accelData = rawData.filter(d => d.type === 'accel').map(d => ({
            ...d,
            total: Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
        }));
        const gyroData = rawData.filter(d => d.type === 'gyro').map(d => ({
            ...d,
            total: Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
        }));

        if (accelData.length < 20) return { steps: [], filtered: [] };

        /* -----------------------------------------------------------
         * V1.1 踵趾步行步检测优化策略：
         * 1. 加速度通道：矢量模 + 移动均值 + 带通0.5~2Hz + 峰值检测（同V1.0）
         * 2. 陀螺仪通道：矢量模 + 带通0.5~3Hz + 包络能量计算
         * 3. 融合验证：加速度检测到候选峰时，检查对应时间窗口内
         *    陀螺仪是否有足够的角速度能量。无能量则可能是误检（仅手抖无身体旋转）。
         * ----------------------------------------------------------- */

        // ── 加速度通道（主检测）──
        const totalSignal = accelData.map(d => d.total);
        const smoothed = this._movingAverage(totalSignal, 5);
        const filtered = this._bandpassFilter(smoothed, 0.5, 2.0, this.targetSampleRate);

        // ── 陀螺仪通道（辅助验证）──
        // 踵趾步行时身体左右摆动产生Y轴（ML方向）为主、Z轴（上下）为辅的角速度
        // 用陀螺仪矢量模捕获整体旋转
        let gyroEnvelope = null;
        const gyroSampleRate = Math.round(gyroData.length > 1
            ? 1000 / ((gyroData[gyroData.length - 1].timestamp - gyroData[0].timestamp) / (gyroData.length - 1))
            : this.targetSampleRate);

        if (gyroData.length > 20) {
            const gyroTotal = gyroData.map(d => d.total);
            // 带通0.5~3Hz（比加速度稍宽，因为身体旋转频率可能略高）
            const gyroFiltered = this._bandpassFilter(gyroTotal, 0.5, 3.0, gyroSampleRate);
            // 取绝对值 + 移动均值平滑 → 得到"能量包络"
            const gyroAbs = gyroFiltered.map(v => Math.abs(v));
            gyroEnvelope = this._movingAverage(gyroAbs, 10); // 100ms窗口平滑
        }

        // ── 融合峰值检测 ──
        const steps = [];
        const minIntervalMs = 500;
        const windowSize = 8;

        const mean = this._mean(filtered);
        const std = this._std(filtered);
        // V1.3调整：提高阈值降低敏感性，减少误检
        const threshold = mean + 0.7 * std;

        for (let i = windowSize; i < filtered.length - windowSize; i++) {
            let isPeak = true;
            for (let j = 1; j <= windowSize; j++) {
                if (filtered[i] <= filtered[i - j] || filtered[i] <= filtered[i + j]) {
                    isPeak = false;
                    break;
                }
            }

            if (!isPeak || filtered[i] <= threshold) continue;

            // 陀螺仪验证：检查加速度峰对应时间窗口内陀螺仪是否有足够能量
            if (gyroEnvelope && gyroEnvelope.length > 0) {
                // 用时间戳映射找到陀螺仪对应的索引范围
                const ts = accelData[i].timestamp;
                const searchWindowMs = 150; // ±150ms搜索窗口
                const gyroEnergy = this._getGyroEnergyInWindow(gyroData, gyroEnvelope, ts, searchWindowMs);

                // 陀螺仪能量阈值：取整个信号的25百分位数作为基线
                const gyroThreshold = this._percentile(gyroEnvelope, 25);
                // V1.3调整：提高陀螺仪验证门槛进一步减少误检
                if (gyroEnergy < gyroThreshold * 0.4 && gyroThreshold > 0.001) {
                    continue; // 跳过此候选步
                }
            }

            const ts = accelData[i].timestamp;
            if (steps.length === 0 || (ts - steps[steps.length - 1].timestamp) >= minIntervalMs) {
                steps.push({
                    timestamp: ts,
                    t: accelData[i].t,
                    amplitude: filtered[i] - mean,
                    index: i
                });
            }
        }

        return { steps, filtered };
    }

    /**
     * 获取指定时间窗口内的陀螺仪能量包络平均值
     */
    _getGyroEnergyInWindow(gyroData, gyroEnvelope, centerTimestamp, windowMs) {
        let sum = 0, count = 0;
        const halfWindow = windowMs / 2;

        for (let i = 0; i < gyroData.length; i++) {
            const dt = Math.abs(gyroData[i].timestamp - centerTimestamp);
            if (dt <= halfWindow && i < gyroEnvelope.length) {
                sum += gyroEnvelope[i];
                count++;
            }
        }

        return count > 0 ? sum / count : 0;
    }

    /**
     * 计算百分位数
     */
    _percentile(arr, p) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        if (lower === upper) return sorted[lower];
        return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
    }

    /**
     * 移动均值平滑
     */
    _movingAverage(signal, windowSize) {
        if (signal.length === 0) return [];
        const half   = Math.floor(windowSize / 2);
        const result = new Array(signal.length);
        for (let i = 0; i < signal.length; i++) {
            let sum = 0, cnt = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(signal.length - 1, i + half); j++) {
                sum += signal[j];
                cnt++;
            }
            result[i] = sum / cnt;
        }
        return result;
    }

    /**
     * 3点中值滤波 — 去除脉冲噪声（异常尖峰），不模糊信号边缘
     * 对每个点取其前后共3个值的中值
     */
    _medianFilter3(signal) {
        if (signal.length === 0) return [];
        const result = new Array(signal.length);
        for (let i = 0; i < signal.length; i++) {
            const a = signal[Math.max(0, i - 1)];
            const b = signal[i];
            const c = signal[Math.min(signal.length - 1, i + 1)];
            result[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // 3值中值
        }
        return result;
    }

    // ====== A. 时域统计参数（~56个）======

    _extractTimeDomain(processed) {
        const result = {};
        
        // 对加速度和陀螺仪分别提取
        ['accel', 'gyro'].forEach(sensor => {
            const data = processed[sensor];
            if (data.length < 5) return;

            const axes = ['x', 'y', 'z'];
            const prefix = sensor === 'accel' ? 'acc' : 'gyr';

            // 三轴 + 矢量模
            [...axes, 'total'].forEach(axis => {
                const values = data.map(d => d[axis]);
                const mean = this._mean(values);
                const std = this._std(values);
                const min = Math.min(...values);
                const max = Math.max(...values);
                const rms = this._rms(values);
                const skew = this._skewness(values);
                const kurt = this._kurtosis(values);

                const label = axis === 'total' ? '' : `_${axis}`;
                result[`${prefix}${label}_mean`] = this._round(mean, 4);
                result[`${prefix}${label}_std`] = this._round(std, 4);
                result[`${prefix}${label}_min`] = this._round(min, 4);
                result[`${prefix}${label}_max`] = this._round(max, 4);
                result[`${prefix}${label}_range`] = this._round(max - min, 4);
                result[`${prefix}${label}_rms`] = this._round(rms, 4);
                result[`${prefix}${label}_skewness`] = this._round(skew, 4);
                result[`${prefix}${label}_kurtosis`] = this._round(kurt, 4);
            });
        });

        return result;
    }

    // ====== B. 轴向分解参数（12个）======

    _extractAxialDecomposition(processed) {
        const accel = processed.accel;
        if (accel.length < 5) return this._emptyAxial();

        // ENu坐标系：X=前后(AP), Y=左右(ML), Z=上下(V)
        // V = z, ML = y, AP = x
        const v = accel.map(d => d.z);
        const ml = accel.map(d => d.y);
        const ap = accel.map(d => d.x);

        return {
            vert_acc_mean: this._round(this._mean(v), 4),
            vert_acc_std: this._round(this._std(v), 4),
            vert_acc_max: this._round(Math.max(...v), 4),
            ml_acc_mean: this._round(this._mean(ml), 4),
            ml_acc_std: this._round(this._std(ml), 4),
            ml_acc_max: this._round(Math.max(...ml), 4),
            ap_acc_mean: this._round(this._mean(ap), 4),
            ap_acc_std: this._round(this._std(ap), 4),
            ap_acc_max: this._round(Math.max(...ap), 4),
            x_peak_to_peak: this._round(Math.max(...ap) - Math.min(...ap), 4),
            y_peak_to_peak: this._round(Math.max(...ml) - Math.min(...ml), 4),
            z_peak_to_peak: this._round(Math.max(...v) - Math.min(...v), 4)
        };
    }

    _emptyAxial() {
        const r = {};
        ['vert_acc_mean', 'vert_acc_std', 'vert_acc_max', 'ml_acc_mean', 'ml_acc_std',
         'ml_acc_max', 'ap_acc_mean', 'ap_acc_std', 'ap_acc_max',
         'x_peak_to_peak', 'y_peak_to_peak', 'z_peak_to_peak'].forEach(k => r[k] = 0);
        return r;
    }

    // ====== C. 频域参数（20个）======

    _extractFrequencyDomain(processed) {
        const result = {};
        const accel = processed.accel;

        if (accel.length < 32) return this._emptyFrequency();

        // 对垂直加速度做FFT（主要步态方向）
        const verticalSignal = accel.map(d => d.z);
        const fftResult = this._fftAnalysis(verticalSignal, this.targetSampleRate);

        result.vert_peak_freq = this._round(fftResult.peakFreq, 2);
        result.vert_peak_magnitude = this._round(fftResult.peakMag, 4);
        result.vert_psd_total = this._round(fftResult.psdTotal, 4);
        result.vert_psd_0_0_5hz = this._round(fftResult.psdBands['0-0.5'] || 0, 4);
        result.vert_psd_0_5_1hz = this._round(fftResult.psdBands['0.5-1'] || 0, 4);
        result.vert_psd_1_2hz = this._round(fftResult.psdBands['1-2'] || 0, 4);
        result.vert_psd_2_5hz = this._round(fftResult.psdBands['2-5'] || 0, 4);
        result.vert_psd_5_10hz = this._round(fftResult.psdBands['5-10'] || 0, 4);
        result.vert_spectral_centroid = this._round(fftResult.spectralCentroid, 2);
        result.vert_spectral_entropy = this._round(fftResult.spectralEntropy, 4);
        result.vert_spectral_spread = this._round(fftResult.spectralSpread, 2);
        result.vert_dominant_freq_ratio = this._round(fftResult.dominantFreqRatio, 4);

        // 三轴各自6个FFT参数
        ['x', 'y', 'z'].forEach(axis => {
            const signal = accel.map(d => d[axis]);
            const fft = this._fftAnalysis(signal, this.targetSampleRate);
            result[`${axis}_fft_peak_freq`] = this._round(fft.peakFreq, 2);
            result[`${axis}_fft_peak_mag`] = this._round(fft.peakMag, 4);
            result[`${axis}_fft_psd_total`] = this._round(fft.psdTotal, 4);
            result[`${axis}_fft_centroid`] = this._round(fft.spectralCentroid, 2);
            result[`${axis}_fft_entropy`] = this._round(fft.spectralEntropy, 4);
            result[`${axis}_fft_spread`] = this._round(fft.spectralSpread, 2);
        });

        return result;
    }

    _emptyFrequency() {
        const r = {};
        ['vert_peak_freq', 'vert_peak_magnitude', 'vert_psd_total',
         'vert_psd_0_0_5hz', 'vert_psd_0_5_1hz', 'vert_psd_1_2hz',
         'vert_psd_2_5hz', 'vert_psd_5_10hz', 'vert_spectral_centroid',
         'vert_spectral_entropy', 'vert_spectral_spread', 'vert_dominant_freq_ratio',
         'x_fft_peak_freq', 'x_fft_peak_mag', 'x_fft_psd_total',
         'x_fft_centroid', 'x_fft_entropy', 'x_fft_spread',
         'y_fft_peak_freq', 'y_fft_peak_mag', 'y_fft_psd_total',
         'y_fft_centroid', 'y_fft_entropy', 'y_fft_spread',
         'z_fft_peak_freq', 'z_fft_peak_mag', 'z_fft_psd_total',
         'z_fft_centroid', 'z_fft_entropy', 'z_fft_spread'
        ].forEach(k => r[k] = 0);
        return r;
    }

    // ====== D. 步态专项参数（35个）======

    _extractGaitSpecific(processed, stepDetection) {
        const steps = stepDetection.steps;
        const accel = processed.accel;
        const duration = processed.duration;
        const result = {};

        // --- 步态事件参数 ---
        result.step_count = steps.length;
        result.step_frequency = duration > 0 ? this._round(steps.length / duration, 2) : 0;

        if (steps.length >= 2) {
            const intervals = [];
            for (let i = 1; i < steps.length; i++) {
                intervals.push(steps[i].timestamp - steps[i - 1].timestamp);
            }
            const intervalSec = intervals.map(v => v / 1000);

            result.step_time_mean = this._round(this._mean(intervalSec), 4);
            result.step_time_std = this._round(this._std(intervalSec), 4);
            result.step_time_cv = this._round(
                this._mean(intervalSec) > 0 ? this._std(intervalSec) / this._mean(intervalSec) : 0, 4
            );

            // 步态不对称性（奇偶步间隔差）
            if (intervals.length >= 3) {
                const oddIntervals = intervals.filter((_, i) => i % 2 === 0);
                const evenIntervals = intervals.filter((_, i) => i % 2 === 1);
                const oddMean = this._mean(oddIntervals) / 1000;
                const evenMean = this._mean(evenIntervals) / 1000;
                const avgInterval = this._mean(intervalSec);
                result.step_time_asymmetry = avgInterval > 0
                    ? this._round(Math.abs(oddMean - evenMean) / avgInterval, 4) : 0;
            } else {
                result.step_time_asymmetry = 0;
            }

            // 步幅周期（两步=一stride）
            if (intervals.length >= 2) {
                const strideIntervals = [];
                for (let i = 1; i < intervals.length; i++) {
                    strideIntervals.push((intervals[i] + intervals[i - 1]) / 1000);
                }
                result.stride_time_mean = this._round(this._mean(strideIntervals), 4);
                result.stride_time_std = this._round(this._std(strideIntervals), 4);
            } else {
                result.stride_time_mean = 0;
                result.stride_time_std = 0;
            }
        } else {
            result.step_time_mean = 0;
            result.step_time_std = 0;
            result.step_time_cv = 0;
            result.step_time_asymmetry = 0;
            result.stride_time_mean = 0;
            result.stride_time_std = 0;
        }

        // --- 支撑相/摆动相估算 ---
        // 通过垂直加速度的极小值近似检测支撑相
        if (accel.length > 50 && steps.length >= 2) {
            const vertAcc = accel.map(d => d.z);
            const filteredVert = this._bandpassFilter(vertAcc, 0.5, 5, this.targetSampleRate);
            const vertMean = this._mean(filteredVert);

            // 在每步之间找最小值点作为足部着地时刻
            let stanceTimes = [];
            let swingTimes = [];

            for (let s = 0; s < steps.length - 1; s++) {
                const startIdx = steps[s].index;
                const endIdx = steps[s + 1].index;
                if (endIdx <= startIdx) continue;

                // 找最小值（着地）位置
                let minVal = Infinity;
                let minIdx = startIdx;
                for (let i = startIdx; i <= endIdx && i < filteredVert.length; i++) {
                    if (filteredVert[i] < minVal) {
                        minVal = filteredVert[i];
                        minIdx = i;
                    }
                }

                // 支撑相：从着地点到加速度回到均值以上
                let stanceEnd = minIdx;
                for (let i = minIdx; i <= endIdx && i < filteredVert.length; i++) {
                    if (filteredVert[i] > vertMean) {
                        stanceEnd = i;
                        break;
                    }
                }

                const stepInterval = endIdx - startIdx;
                const stanceDuration = (stanceEnd - minIdx) / this.targetSampleRate;
                const swingDuration = stepInterval / this.targetSampleRate - stanceDuration;

                if (stanceDuration > 0 && swingDuration > 0) {
                    stanceTimes.push(stanceDuration);
                    swingTimes.push(swingDuration);
                }
            }

            result.stance_time_mean = this._round(this._mean(stanceTimes), 4);
            result.swing_time_mean = this._round(this._mean(swingTimes), 4);
            const totalMean = result.stance_time_mean + result.swing_time_mean;
            result.stance_swing_ratio = totalMean > 0
                ? this._round(result.stance_time_mean / result.swing_time_mean, 4) : 0;
        } else {
            result.stance_time_mean = 0;
            result.swing_time_mean = 0;
            result.stance_swing_ratio = 0;
        }

        // --- Sway（摆动/晃动）参数 ---
        const sway = this._computeSway(accel, processed.gyro);
        Object.assign(result, sway);

        // --- Jerk（加加速度） ---
        const jerk = this._computeJerk(accel);
        result.jerk_mean = this._round(jerk.mean, 4);
        result.jerk_total = this._round(jerk.total, 4);
        result.acceleration_events_count = jerk.eventCount;

        // --- 行走直线度 ---
        const linearity = this._computeLinearity(accel);
        Object.assign(result, linearity);

        // --- 节奏规律性 ---
        const rhythmicity = this._computeRhythmicity(accel, steps);
        Object.assign(result, rhythmicity);

        return result;
    }

    _computeSway(accel, gyro = []) {
        if (accel.length < 10) {
            return {
                sway_path_length: 0, sway_velocity_mean: 0, sway_velocity_std: 0,
                sway_velocity_max: 0, sway_area: 0, sway_ellipse_area: 0,
                sway_ellipse_major: 0, sway_ellipse_minor: 0, sway_ellipse_orientation: 0,
                acc_sway_rms_ap: 0, acc_sway_rms_ml: 0, acc_sway_rms_vert: 0, acc_sway_rms_3d: 0,
                gyro_sway_rms_ml: 0, gyro_sway_rms_ap: 0, gyro_sway_rms_3d: 0,
                combined_balance_index: 0
            };
        }

        /* ---------------------------------------------------------------
         * 坐标系（屏幕朝前进方向握持，ENu归一化后）：
         *   x = 前后(AP, Anterior-Posterior)
         *   y = 左右(ML, Medio-Lateral)
         *   z = 上下(Vertical)
         *
         * 晃动面积：用 AP(x) × ML(y) 二维平面位移轨迹计算
         * 垂直方向(z)不参与面积计算（属于正常步态律动），
         * 但单独提供 acc_sway_rms_vert 以备非线性分析使用。
         * --------------------------------------------------------------- */

        // ---- 加速度 RMS（反映各方向晃动烈度）----
        // 去除重力偏置后的动态加速度（低通截止0.8Hz去直流）
        const apRaw  = accel.map(d => d.x);  // 前后
        const mlRaw  = accel.map(d => d.y);  // 左右
        const vertRaw= accel.map(d => d.z);  // 上下

        // 去均值（消除重力/持续偏置）
        const apDyn   = this._removeMean(apRaw);
        const mlDyn   = this._removeMean(mlRaw);
        const vertDyn = this._removeMean(vertRaw);

        const rmsAP   = this._rms(apDyn);
        const rmsML   = this._rms(mlDyn);
        const rmsVert = this._rms(vertDyn);
        // 三维综合 RMS（三方向均方根合成）
        const rms3D   = Math.sqrt((rmsAP * rmsAP + rmsML * rmsML + rmsVert * rmsVert) / 3);

        // ---- 陀螺仪 RMS（V1.1新增：反映身体旋转晃动烈度）----
        // 踵趾步行中身体左右摆动（Y轴/ML方向）和前后晃动（X轴/AP方向）会产生角速度
        // 陀螺仪RMS与加速度RMS互补：加速度反映位移幅度，陀螺仪反映旋转速度
        let gyroRMSML = 0, gyroRMSAP = 0, gyroRMS3D = 0;
        if (gyro.length > 10) {
            const gyroAP  = gyro.map(d => d.x);  // 前后旋转（俯仰）
            const gyroML  = gyro.map(d => d.y);  // 左右旋转（侧倾）
            const gyroVert= gyro.map(d => d.z);  // 上下旋转（偏航）

            const gyroAPDyn   = this._removeMean(gyroAP);
            const gyroMLDyn   = this._removeMean(gyroML);
            const gyroVertDyn = this._removeMean(gyroVert);

            gyroRMSAP = this._rms(gyroAPDyn);
            gyroRMSML = this._rms(gyroMLDyn);
            const gyroRMSVert = this._rms(gyroVertDyn);
            gyroRMS3D = Math.sqrt((gyroRMSAP * gyroRMSAP + gyroRMSML * gyroRMSML + gyroRMSVert * gyroRMSVert) / 3);
        }

        // ---- 合成平衡指数（V1.1新增）----
        // 结合加速度和陀螺仪的综合平衡指标
        // 公式：combined_balance_index = sqrt(acc_rms_3d^2 + (gyro_rms_3d * k)^2)
        // 其中 k 是经验系数，将角速度单位(rad/s)转换为等效加速度单位(m/s²)
        // 参考：典型步态中，1 rad/s 角速度约对应 0.5 m/s² 的离心加速度（a = ω²r, r≈0.5m）
        const k = 0.5; // 转换系数
        const combinedBalanceIndex = Math.sqrt(rms3D * rms3D + (gyroRMS3D * k) * (gyroRMS3D * k));

        // ---- 位移轨迹（AP × ML 平面）----
        const dt = 1 / this.targetSampleRate;
        const mlAcc = this._lowPassFilter(mlRaw, 0.8);
        const apAcc = this._lowPassFilter(apRaw, 0.8);

        let vx = 0, vy = 0;
        let pathLength = 0;
        let prevX = 0, prevY = 0;
        const positions = [];
        const velocities = [];

        for (let i = 0; i < mlAcc.length; i++) {
            vx += mlAcc[i] * dt;
            vy += apAcc[i] * dt;
            // 加阻尼防止漂移
            vx *= 0.99;
            vy *= 0.99;

            const x = prevX + vx * dt;
            const y = prevY + vy * dt;

            const dx = x - prevX;
            const dy = y - prevY;
            pathLength += Math.sqrt(dx * dx + dy * dy);

            const v = Math.sqrt(vx * vx + vy * vy);
            velocities.push(v);

            positions.push({ x, y });
            prevX = x;
            prevY = y;
        }

        // ---- 椭圆拟合（PCA，稳健）----
        const ellipse = this._fitEllipse(positions);

        // ---- 面积：优先用椭圆面积（更稳健），同时保留 shoelace 供参考 ----
        // shoelace面积（原始算法，对开放轨迹偏差较大）
        let shoelaceArea = 0;
        if (positions.length > 2) {
            for (let i = 0; i < positions.length; i++) {
                const j = (i + 1) % positions.length;
                shoelaceArea += positions[i].x * positions[j].y;
                shoelaceArea -= positions[j].x * positions[i].y;
            }
            shoelaceArea = Math.abs(shoelaceArea) / 2;
        }

        // 主 sway_area 使用椭圆面积（95%置信椭圆，更接近临床定义）
        const swayArea = ellipse.area;

        const velArr = velocities.length > 0 ? velocities : [0];

        return {
            sway_path_length:        this._round(pathLength, 4),
            sway_velocity_mean:      this._round(this._mean(velArr), 4),
            sway_velocity_std:       this._round(this._std(velArr), 4),
            sway_velocity_max:       this._round(Math.max(...velArr), 4),
            sway_area:               this._round(swayArea, 6),        // 主指标：椭圆面积(m²)
            sway_area_shoelace:      this._round(shoelaceArea, 6),    // 参考：shoelace面积
            sway_ellipse_area:       this._round(ellipse.area, 6),
            sway_ellipse_major:      this._round(ellipse.major, 4),
            sway_ellipse_minor:      this._round(ellipse.minor, 4),
            sway_ellipse_orientation:this._round(ellipse.orientation, 2),
            // 三方向动态加速度 RMS（反映晃动幅度，不受姿势偏置影响）
            acc_sway_rms_ap:         this._round(rmsAP,   4),   // 前后
            acc_sway_rms_ml:         this._round(rmsML,   4),   // 左右
            acc_sway_rms_vert:       this._round(rmsVert, 4),   // 上下
            acc_sway_rms_3d:         this._round(rms3D,   4),   // 综合三维
            // V1.1新增：陀螺仪RMS（反映身体旋转晃动）
            gyro_sway_rms_ap:        this._round(gyroRMSAP,  4), // 前后旋转
            gyro_sway_rms_ml:        this._round(gyroRMSML,  4), // 左右旋转
            gyro_sway_rms_3d:        this._round(gyroRMS3D,  4), // 综合三维旋转
            // V1.1新增：合成平衡指数（加速度+陀螺仪融合）
            combined_balance_index:  this._round(combinedBalanceIndex, 4)
        };
    }

    /** 去均值（去除直流偏置） */
    _removeMean(signal) {
        if (!signal || signal.length === 0) return [];
        const mean = this._mean(signal);
        return signal.map(v => v - mean);
    }

    _computeJerk(accel) {
        if (accel.length < 10) return { mean: 0, total: 0, eventCount: 0 };

        const dt = 1 / this.targetSampleRate;
        const total = accel.map(d => d.total);
        let jerkSum = 0;
        let jerkSqSum = 0;
        let eventCount = 0;
        const jerkThreshold = 50; // m/s³

        for (let i = 2; i < total.length; i++) {
            const jerk = Math.abs(total[i] - 2 * total[i - 1] + total[i - 2]) / (dt * dt);
            jerkSum += jerk;
            jerkSqSum += jerk * jerk;
            if (jerk > jerkThreshold) eventCount++;
        }

        const n = Math.max(1, total.length - 2);
        return {
            mean: jerkSum / n,
            total: Math.sqrt(jerkSqSum / n),
            eventCount
        };
    }

    _computeLinearity(accel) {
        if (accel.length < 10) {
            return {
                net_displacement: 0, total_length: 0, directness_ratio: 0,
                lateral_deviation_std: 0, forward_progression_rate: 0
            };
        }

        const dt = 1 / this.targetSampleRate;
        // 双重积分加速度得到位移（简化版，有漂移但相对比较有效）
        const fwdAcc = this._lowPassFilter(accel.map(d => d.x), 0.5);
        const latAcc = this._lowPassFilter(accel.map(d => d.y), 0.5);

        let vx = 0, vy = 0, px = 0, py = 0;
        let totalLength = 0;
        const lateralDeviations = [];

        for (let i = 0; i < fwdAcc.length; i++) {
            vx += fwdAcc[i] * dt;
            vy += latAcc[i] * dt;
            vx *= 0.98; vy *= 0.98; // 阻尼

            const dx = vx * dt;
            const dy = vy * dt;
            px += dx;
            py += dy;

            totalLength += Math.sqrt(dx * dx + dy * dy);
            lateralDeviations.push(py);
        }

        const netDisp = Math.sqrt(px * px + py * py);
        const directness = totalLength > 0 ? netDisp / totalLength : 0;
        const fwdRate = Math.abs(px) > 0 ? Math.abs(px) : 0;

        return {
            net_displacement: this._round(netDisp, 4),
            total_length: this._round(totalLength, 4),
            directness_ratio: this._round(directness, 4),
            lateral_deviation_std: this._round(this._std(lateralDeviations), 4),
            forward_progression_rate: this._round(fwdRate, 4)
        };
    }

    _computeRhythmicity(accel, steps) {
        if (accel.length < 50) {
            return { step_interval_autocorr: 0, acc_autocorr_peak: 0 };
        }

        // 步间隔自相关
        if (steps.length >= 4) {
            const intervals = [];
            for (let i = 1; i < steps.length; i++) {
                intervals.push(steps[i].timestamp - steps[i - 1].timestamp);
            }
            const mean = this._mean(intervals);
            const std = this._std(intervals);
            const normalized = intervals.map(v => (v - mean) / (std || 1));

            // 滞后1自相关
            let sum = 0;
            for (let i = 1; i < normalized.length; i++) {
                sum += normalized[i] * normalized[i - 1];
            }
            const autocorr = sum / (normalized.length - 1);
            return {
                step_interval_autocorr: this._round(autocorr, 4),
                acc_autocorr_peak: this._round(this._accelAutocorrPeak(accel), 4)
            };
        }

        return {
            step_interval_autocorr: 0,
            acc_autocorr_peak: this._round(this._accelAutocorrPeak(accel), 4)
        };
    }

    _accelAutocorrPeak(accel) {
        const signal = accel.map(d => d.z);
        const n = Math.min(signal.length, 500); // 限制计算量
        if (n < 32) return 0;

        // 归一化
        const mean = this._mean(signal.slice(0, n));
        const std = this._std(signal.slice(0, n));
        if (std === 0) return 0;
        const norm = signal.slice(0, n).map(v => (v - mean) / std);

        // 计算自相关，找第一个峰
        let maxAutocorr = -Infinity;
        const minLag = Math.floor(0.3 * this.targetSampleRate); // 0.3秒
        const maxLag = Math.floor(2.0 * this.targetSampleRate); // 2.0秒

        for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
            let sum = 0;
            const count = n - lag;
            for (let i = 0; i < count; i++) {
                sum += norm[i] * norm[i + lag];
            }
            const r = sum / count;
            if (r > maxAutocorr) maxAutocorr = r;
        }

        return maxAutocorr;
    }

    // ====== E. 非线性动力学参数（12个）======

    _extractNonlinearDynamics(processed) {
        const accel = processed.accel;
        const gyro = processed.gyro;
        const result = {};

        if (accel.length < 50) return this._emptyNonlinear();

        const accSignal = accel.map(d => d.z); // 垂直加速度
        const gyrSignal = gyro.length > 50 ? gyro.map(d => d.z) : accSignal;

        // 样本熵
        result.sample_entropy = this._round(this._sampleEntropy(accSignal, 2, 0.2), 4);
        result.gyro_sample_entropy = this._round(this._sampleEntropy(gyrSignal, 2, 0.2), 4);

        // 近似熵
        result.approx_entropy = this._round(this._approxEntropy(accSignal, 2, 0.2), 4);

        // Hurst指数
        result.hurst_exponent = this._round(this._hurstExponent(accSignal), 4);
        result.gyro_hurst_exponent = this._round(this._hurstExponent(gyrSignal), 4);

        // 分形维数（DFA）
        result.fractal_dimension_dfa = this._round(this._dfa(accSignal), 4);

        // 轴间互信息
        const ax = accel.map(d => d.x);
        const ay = accel.map(d => d.y);
        const az = accel.map(d => d.z);
        result.mutual_info_xy = this._round(this._mutualInformation(ax, ay), 4);
        result.mutual_info_xz = this._round(this._mutualInformation(ax, az), 4);
        result.mutual_info_yz = this._round(this._mutualInformation(ay, az), 4);

        // LF/HF功率比（从FFT）
        const fft = this._fftAnalysis(accSignal, this.targetSampleRate);
        const lfPower = (fft.psdBands['0.5-1'] || 0) + (fft.psdBands['1-2'] || 0);
        const hfPower = (fft.psdBands['2-5'] || 0) + (fft.psdBands['5-10'] || 0);
        result.power_spectral_ratio_lf_hf = hfPower > 0
            ? this._round(lfPower / hfPower, 4) : 0;

        // V1.1新增：频段能量占比（归一化，不受个体运动幅度影响）
        const totalPower = lfPower + hfPower + (fft.psdBands['0-0.5'] || 0);
        if (totalPower > 0) {
            result.low_freq_energy_ratio = this._round(lfPower / totalPower, 4);   // 0.5-2Hz占比
            result.high_freq_energy_ratio = this._round(hfPower / totalPower, 4);  // 2-10Hz占比
            result.ultra_low_freq_ratio = this._round((fft.psdBands['0-0.5'] || 0) / totalPower, 4); // <0.5Hz占比
        } else {
            result.low_freq_energy_ratio = 0;
            result.high_freq_energy_ratio = 0;
            result.ultra_low_freq_ratio = 0;
        }

        // 近似最大Lyapunov指数
        result.lyapunov_exponent_approx = this._round(this._lyapunovExponent(accSignal), 4);

        return result;
    }

    _emptyNonlinear() {
        const r = {};
        ['sample_entropy', 'gyro_sample_entropy', 'approx_entropy',
         'hurst_exponent', 'gyro_hurst_exponent', 'fractal_dimension_dfa',
         'mutual_info_xy', 'mutual_info_xz', 'mutual_info_yz',
         'power_spectral_ratio_lf_hf', 'lyapunov_exponent_approx',
         'low_freq_energy_ratio', 'high_freq_energy_ratio', 'ultra_low_freq_ratio'
        ].forEach(k => r[k] = 0);
        return r;
    }

    // ====== F. 时间分段比较参数（10个）======

    _extractTimeSegmentation(processed) {
        const accel = processed.accel;
        if (accel.length < 100) return this._emptyTimeSegment();

        const duration = accel[accel.length - 1].t - accel[0].t;
        const midTime = accel[0].t + duration / 2;

        const firstHalf = accel.filter(d => d.t <= midTime);
        const secondHalf = accel.filter(d => d.t > midTime);

        if (firstHalf.length < 10 || secondHalf.length < 10) return this._emptyTimeSegment();

        // 前5秒 vs 后5秒
        const firstTotal = firstHalf.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
        const secondTotal = secondHalf.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));

        // 步频差值
        const firstSteps = processed.raw.filter(d => d.type === 'accel' && d.t <= midTime);
        const secondSteps = processed.raw.filter(d => d.type === 'accel' && d.t > midTime);

        // 简单加速度变化率估算步频
        const firstFreq = this._estimateFrequency(firstTotal);
        const secondFreq = this._estimateFrequency(secondTotal);

        // Sway area差值
        const firstSway = this._computeSwaySimple(firstHalf);
        const secondSway = this._computeSwaySimple(secondHalf);

        // Jerk比值
        const firstJerk = this._jerkMean(firstTotal);
        const secondJerk = this._jerkMean(secondTotal);

        // 四分位趋势
        const quarterSize = Math.floor(accel.length / 4);
        const quarters = [
            accel.slice(0, quarterSize),
            accel.slice(quarterSize, quarterSize * 2),
            accel.slice(quarterSize * 2, quarterSize * 3),
            accel.slice(quarterSize * 3)
        ];

        const quarterMeans = quarters.map(q =>
            this._mean(q.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)))
        );

        // 趋势斜率（线性回归）
        const slope = this._linearSlope(quarterMeans);

        return {
            acc_mean_diff_first_second: this._round(
                this._mean(secondTotal) - this._mean(firstTotal), 4),
            step_freq_diff_first_second: this._round(secondFreq - firstFreq, 2),
            sway_area_diff_first_second: this._round(secondSway - firstSway, 4),
            jerk_ratio_first_second: this._round(
                firstJerk > 0 ? secondJerk / firstJerk : 0, 4),
            quarter_1_acc_mean: this._round(quarterMeans[0], 4),
            quarter_2_acc_mean: this._round(quarterMeans[1], 4),
            quarter_3_acc_mean: this._round(quarterMeans[2], 4),
            quarter_4_acc_mean: this._round(quarterMeans[3], 4),
            trend_slope: this._round(slope, 6)
        };
    }

    _emptyTimeSegment() {
        const r = {};
        ['acc_mean_diff_first_second', 'step_freq_diff_first_second',
         'sway_area_diff_first_second', 'jerk_ratio_first_second',
         'quarter_1_acc_mean', 'quarter_2_acc_mean', 'quarter_3_acc_mean',
         'quarter_4_acc_mean', 'trend_slope'
        ].forEach(k => r[k] = 0);
        return r;
    }

    // ====== G. 传感器质控参数（8个）======

    _extractQualityParams(rawData, processed) {
        const saturatedCount = rawData.filter(d => d.saturated).length;
        const totalCount = rawData.length;
        
        // 噪底估算（静止段的标准差）
        const accel = processed.accel;
        let noiseFloor = 0;
        if (accel.length > 100) {
            // 取前100个点估算噪底
            const first100 = accel.slice(0, Math.min(100, accel.length));
            noiseFloor = this._rms(first100.map(d => d.total));
        }

        // 有效数据比例
        const validRatio = totalCount > 0
            ? ((totalCount - saturatedCount) / totalCount) : 0;

        // 信号质量评分（0-100）
        let qualityScore = 100;
        qualityScore -= Math.min(30, (saturatedCount / Math.max(1, totalCount)) * 100);
        if (processed.duration < 5) qualityScore -= 30;
        if (processed.duration < 8) qualityScore -= 10;
        if (totalCount < 500) qualityScore -= 20;
        qualityScore = Math.max(0, Math.min(100, qualityScore));

        return {
            signal_saturation_rate: this._round(
                totalCount > 0 ? saturatedCount / totalCount * 100 : 0, 2),
            noise_floor: this._round(noiseFloor, 4),
            missing_data_points: 0, // 由SensorManager计算
            sampling_rate_actual: this.targetSampleRate, // 由SensorManager更新
            accelerometer_range_used: 0, // 需要API支持
            temperature_drift_estimate: 0, // 手机传感器通常不暴露温度
            signal_quality_score: this._round(qualityScore, 1),
            valid_data_ratio: this._round(validRatio, 4)
        };
    }

    // ====== mJOA预测 ======

    _predictMJOA(gaitSpecific, timeDomain, quality) {
        let score = 4;

        // 稳定性相关（步态变异系数）
        const stepCV = gaitSpecific.step_time_cv || 0;
        if (stepCV > 0.3) score -= 1;
        if (stepCV > 0.5) score -= 1;

        // 步频
        const freq = gaitSpecific.step_frequency || 0;
        if (freq < 0.5) score -= 0.5;
        if (freq < 0.3) score -= 1;

        // 步数
        if (gaitSpecific.step_count < 3) score -= 1;

        // Sway
        const swayArea = gaitSpecific.sway_area || 0;
        if (swayArea > 0.01) score -= 0.5;
        if (swayArea > 0.05) score -= 0.5;

        // 加速度标准差（整体运动幅度）
        const accStd = timeDomain.acc_total_std || 0;
        if (accStd < 0.5) score -= 0.5;

        // 步态不对称性
        if (gaitSpecific.step_time_asymmetry > 0.3) score -= 0.5;

        score = Math.max(0, Math.min(4, score));

        const descriptions = {
            0: '严重受损', 1: '重度异常', 2: '中度异常',
            3: '轻度异常', 4: '正常'
        };

        let confidence = 60;
        if (gaitSpecific.step_count > 5) confidence += 10;
        if (quality.signal_quality_score > 70) confidence += 10;
        if (gaitSpecific.step_count > 10) confidence += 5;

        return {
            score: Math.round(score),
            confidence: Math.min(95, confidence),
            description: descriptions[Math.round(score)]
        };
    }

    // ====== 数学工具函数 ======

    _round(value, decimals) {
        if (typeof value !== 'number' || !isFinite(value)) return 0;
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    _mean(arr) {
        if (!arr || arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    _std(arr) {
        if (!arr || arr.length < 2) return 0;
        const mean = this._mean(arr);
        const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
        return Math.sqrt(variance);
    }

    _rms(arr) {
        if (!arr || arr.length === 0) return 0;
        const sumSq = arr.reduce((sum, v) => sum + v * v, 0);
        return Math.sqrt(sumSq / arr.length);
    }

    _skewness(arr) {
        if (!arr || arr.length < 3) return 0;
        const n = arr.length;
        const mean = this._mean(arr);
        const std = this._std(arr);
        if (std === 0) return 0;
        const m3 = arr.reduce((sum, v) => sum + ((v - mean) / std) ** 3, 0);
        return (n / ((n - 1) * (n - 2))) * m3;
    }

    _kurtosis(arr) {
        if (!arr || arr.length < 4) return 0;
        const n = arr.length;
        const mean = this._mean(arr);
        const std = this._std(arr);
        if (std === 0) return 0;
        const m4 = arr.reduce((sum, v) => sum + ((v - mean) / std) ** 4, 0);
        // 超额峰度
        const k = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * m4
                  - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
        return k;
    }

    // ====== 滤波器 ======

    /**
     * 二阶Butterworth带通滤波器
     */
    _bandpassFilter(signal, lowCut, highCut, sampleRate) {
        // 先低通再高通
        const lp = this._butterLowPass(signal, highCut, sampleRate);
        return this._butterHighPass(lp, lowCut, sampleRate);
    }

    /**
     * 二阶Butterworth低通滤波器
     */
    _butterLowPass(signal, cutoff, sampleRate) {
        const wc = Math.tan(Math.PI * cutoff / sampleRate);
        const wc2 = wc * wc;
        const k = Math.SQRT2 * wc;
        const denom = 1 + k + wc2;

        const b0 = wc2 / denom;
        const b1 = 2 * b0;
        const b2 = b0;
        const a1 = 2 * (wc2 - 1) / denom;
        const a2 = (1 - k + wc2) / denom;

        return this._applyIIR(signal, [b0, b1, b2], [1, a1, a2]);
    }

    /**
     * 二阶Butterworth高通滤波器
     */
    _butterHighPass(signal, cutoff, sampleRate) {
        const wc = Math.tan(Math.PI * cutoff / sampleRate);
        const wc2 = wc * wc;
        const k = Math.SQRT2 * wc;
        const denom = 1 + k + wc2;

        const b0 = 1 / denom;
        const b1 = -2 * b0;
        const b2 = b0;
        const a1 = 2 * (wc2 - 1) / denom;
        const a2 = (1 - k + wc2) / denom;

        return this._applyIIR(signal, [b0, b1, b2], [1, a1, a2]);
    }

    /**
     * 简单一阶低通滤波
     */
    _lowPassFilter(signal, cutoff) {
        const alpha = Math.min(1, 2 * Math.PI * cutoff / this.targetSampleRate);
        const result = [signal[0]];
        for (let i = 1; i < signal.length; i++) {
            result.push(alpha * signal[i] + (1 - alpha) * result[i - 1]);
        }
        return result;
    }

    /**
     * IIR滤波器应用
     */
    _applyIIR(signal, b, a) {
        if (signal.length === 0) return [];
        const result = new Array(signal.length);
        result[0] = b[0] * signal[0];

        for (let i = 1; i < signal.length; i++) {
            let y = b[0] * signal[i];
            for (let j = 1; j < b.length && j <= i; j++) {
                y += b[j] * signal[i - j];
            }
            for (let j = 1; j < a.length && j <= i; j++) {
                y -= a[j] * result[i - j];
            }
            result[i] = y;
        }
        return result;
    }

    // ====== FFT实现（Cooley-Tukey）======

    _fftAnalysis(signal, sampleRate) {
        // 补零到2的幂
        let n = 1;
        while (n < signal.length) n *= 2;
        n = Math.max(n, 64);

        const padded = new Array(n).fill(0);
        for (let i = 0; i < signal.length; i++) padded[i] = signal[i];

        // 去均值
        const mean = this._mean(padded);
        for (let i = 0; i < n; i++) padded[i] -= mean;

        // 加Hanning窗
        for (let i = 0; i < n; i++) {
            padded[i] *= 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
        }

        // FFT
        const spectrum = this._fft(padded);

        // 功率谱密度
        const halfN = Math.floor(n / 2);
        const psd = new Array(halfN);
        for (let i = 0; i < halfN; i++) {
            psd[i] = (spectrum[i].re * spectrum[i].re + spectrum[i].im * spectrum[i].im) / (n * sampleRate);
        }

        // 峰值频率
        let peakFreq = 0, peakMag = 0;
        let psdTotal = 0;
        const psdBands = {};

        const bands = [
            { name: '0-0.5', lo: 0, hi: 0.5 },
            { name: '0.5-1', lo: 0.5, hi: 1 },
            { name: '1-2', lo: 1, hi: 2 },
            { name: '2-5', lo: 2, hi: 5 },
            { name: '5-10', lo: 5, hi: 10 }
        ];

        // 初始化频段
        bands.forEach(b => psdBands[b.name] = 0);

        for (let i = 1; i < halfN; i++) {
            const freq = i * sampleRate / n;
            const mag = Math.sqrt(psd[i]);
            psdTotal += psd[i];

            if (mag > peakMag && freq < 10) {
                peakMag = mag;
                peakFreq = freq;
            }

            bands.forEach(b => {
                if (freq >= b.lo && freq < b.hi) {
                    psdBands[b.name] += psd[i];
                }
            });
        }

        // 频谱质心
        let weightedSum = 0, psdSum = 0;
        for (let i = 1; i < halfN; i++) {
            const freq = i * sampleRate / n;
            weightedSum += freq * psd[i];
            psdSum += psd[i];
        }
        const spectralCentroid = psdSum > 0 ? weightedSum / psdSum : 0;

        // 频谱熵
        let entropy = 0;
        if (psdSum > 0) {
            for (let i = 1; i < halfN; i++) {
                const p = psd[i] / psdSum;
                if (p > 1e-10) entropy -= p * Math.log2(p);
            }
        }

        // 频谱扩展
        let spreadSum = 0;
        for (let i = 1; i < halfN; i++) {
            const freq = i * sampleRate / n;
            spreadSum += (freq - spectralCentroid) ** 2 * psd[i];
        }
        const spectralSpread = psdSum > 0 ? Math.sqrt(spreadSum / psdSum) : 0;

        // 主频占比
        let peakBin = Math.round(peakFreq * n / sampleRate);
        if (peakBin < 1) peakBin = 1;
        if (peakBin >= halfN) peakBin = halfN - 1;
        const dominantRatio = psdSum > 0
            ? (psd[peakBin] + (peakBin + 1 < halfN ? psd[peakBin + 1] : 0) +
               (peakBin - 1 >= 0 ? psd[peakBin - 1] : 0)) / psdSum : 0;

        return {
            peakFreq,
            peakMag,
            psdTotal,
            psdBands,
            spectralCentroid,
            spectralEntropy: entropy,
            spectralSpread,
            dominantFreqRatio: dominantRatio
        };
    }

    /**
     * Cooley-Tukey FFT算法（基2，就地计算）
     */
    _fft(x) {
        const n = x.length;
        const result = new Array(n);
        for (let i = 0; i < n; i++) result[i] = { re: x[i], im: 0 };

        // 比特反转排列
        let j = 0;
        for (let i = 0; i < n; i++) {
            if (j > i) {
                const tmp = result[j];
                result[j] = result[i];
                result[i] = tmp;
            }
            let m = n >> 1;
            while (m >= 1 && j >= m) {
                j -= m;
                m >>= 1;
            }
            j += m;
        }

        // 蝶形运算
        for (let size = 2; size <= n; size *= 2) {
            const halfSize = size >> 1;
            const angle = -2 * Math.PI / size;
            const wReal = Math.cos(angle);
            const wImag = Math.sin(angle);

            for (let i = 0; i < n; i += size) {
                let curReal = 1, curImag = 0;
                for (let k = 0; k < halfSize; k++) {
                    const evenIdx = i + k;
                    const oddIdx = i + k + halfSize;

                    const tReal = curReal * result[oddIdx].re - curImag * result[oddIdx].im;
                    const tImag = curReal * result[oddIdx].im + curImag * result[oddIdx].re;

                    result[oddIdx].re = result[evenIdx].re - tReal;
                    result[oddIdx].im = result[evenIdx].im - tImag;
                    result[evenIdx].re += tReal;
                    result[evenIdx].im += tImag;

                    const newCurReal = curReal * wReal - curImag * wImag;
                    curImag = curReal * wImag + curImag * wReal;
                    curReal = newCurReal;
                }
            }
        }

        return result;
    }

    // ====== 非线性动力学算法 ======

    /**
     * 样本熵 (Richman-Moorman算法)
     */
    _sampleEntropy(signal, m, r) {
        if (signal.length < m + 10) return 0;

        const std = this._std(signal);
        if (std === 0) return 0;
        const tolerance = r * std;

        const N = signal.length;
        const phiM = this._countMatches(signal, m, tolerance, N);
        const phiM1 = this._countMatches(signal, m + 1, tolerance, N);

        if (phiM === 0 || phiM1 === 0) return 0;
        return -Math.log(phiM1 / phiM);
    }

    _countMatches(signal, m, tolerance, N) {
        let count = 0;
        let total = 0;

        for (let i = 0; i <= N - m; i++) {
            for (let j = i + 1; j <= N - m; j++) {
                let match = true;
                for (let k = 0; k < m; k++) {
                    if (Math.abs(signal[i + k] - signal[j + k]) > tolerance) {
                        match = false;
                        break;
                    }
                }
                if (match) count++;
                total++;
            }
        }

        return total > 0 ? count / total : 0;
    }

    /**
     * 近似熵
     */
    _approxEntropy(signal, m, r) {
        if (signal.length < m + 10) return 0;

        const std = this._std(signal);
        if (std === 0) return 0;
        const tolerance = r * std;

        const phiM = this._approxEntropyPhi(signal, m, tolerance);
        const phiM1 = this._approxEntropyPhi(signal, m + 1, tolerance);

        return phiM - phiM1;
    }

    _approxEntropyPhi(signal, m, tolerance) {
        const N = signal.length;
        const logSum = [];

        for (let i = 0; i <= N - m; i++) {
            let matchCount = 0;
            for (let j = 0; j <= N - m; j++) {
                if (i === j) continue;
                let match = true;
                for (let k = 0; k < m; k++) {
                    if (Math.abs(signal[i + k] - signal[j + k]) > tolerance) {
                        match = false;
                        break;
                    }
                }
                if (match) matchCount++;
            }
            if (matchCount > 0) {
                logSum.push(Math.log((matchCount + 1) / (N - m + 1)));
            } else {
                logSum.push(Math.log(1 / (N - m + 1)));
            }
        }

        return logSum.reduce((a, b) => a + b, 0) / logSum.length;
    }

    /**
     * Hurst指数（R/S分析法）
     */
    _hurstExponent(signal) {
        if (signal.length < 50) return 0.5;

        const sizes = [8, 16, 32, 64, 128].filter(s => s <= Math.floor(signal.length / 2));
        if (sizes.length < 2) return 0.5;

        const logRS = [];
        const logN = [];

        for (const size of sizes) {
            const numBlocks = Math.floor(signal.length / size);
            let totalRS = 0;

            for (let b = 0; b < numBlocks; b++) {
                const block = signal.slice(b * size, (b + 1) * size);
                const mean = this._mean(block);
                const cumDev = [];
                let cumSum = 0;

                for (let i = 0; i < block.length; i++) {
                    cumSum += block[i] - mean;
                    cumDev.push(cumSum);
                }

                const R = Math.max(...cumDev) - Math.min(...cumDev);
                const S = this._std(block);
                totalRS += S > 0 ? R / S : 0;
            }

            const avgRS = totalRS / numBlocks;
            if (avgRS > 0) {
                logRS.push(Math.log(avgRS));
                logN.push(Math.log(size));
            }
        }

        if (logRS.length < 2) return 0.5;

        // 线性回归求斜率
        return this._linearSlope(logN, logRS);
    }

    /**
     * DFA (Detrended Fluctuation Analysis)
     */
    _dfa(signal) {
        if (signal.length < 64) return 1;

        const mean = this._mean(signal);
        const profile = [];
        let cumSum = 0;
        for (let i = 0; i < signal.length; i++) {
            cumSum += signal[i] - mean;
            profile.push(cumSum);
        }

        const scales = [4, 8, 16, 32, 64].filter(s => s <= Math.floor(signal.length / 4));
        if (scales.length < 2) return 1;

        const logF = [];
        const logS = [];

        for (const scale of scales) {
            const n = Math.floor(profile.length / scale);
            let totalFq = 0;

            for (let i = 0; i < n; i++) {
                const segment = profile.slice(i * scale, (i + 1) * scale);
                // 线性去趋势
                const x = [];
                const y = [];
                for (let j = 0; j < segment.length; j++) {
                    x.push(j);
                    y.push(segment[j]);
                }
                const slope = this._linearSlope(x, y);
                const intercept = this._mean(y) - slope * this._mean(x);

                let fq = 0;
                for (let j = 0; j < segment.length; j++) {
                    const detrended = segment[j] - (slope * j + intercept);
                    fq += detrended * detrended;
                }
                totalFq += fq / segment.length;
            }

            const F = Math.sqrt(totalFq / n);
            if (F > 0) {
                logF.push(Math.log(F));
                logS.push(Math.log(scale));
            }
        }

        if (logF.length < 2) return 1;
        return this._linearSlope(logS, logF);
    }

    /**
     * 互信息（直方图法）
     */
    _mutualInformation(x, y) {
        if (!x || !y || x.length < 20 || x.length !== y.length) return 0;

        const bins = Math.max(4, Math.floor(Math.sqrt(x.length / 2)));
        const xMin = Math.min(...x), xMax = Math.max(...x);
        const yMin = Math.min(...y), yMax = Math.max(...y);

        const xRange = xMax - xMin || 1;
        const yRange = yMax - yMin || 1;

        // 联合直方图
        const joint = {};
        const xHist = new Array(bins).fill(0);
        const yHist = new Array(bins).fill(0);
        const n = x.length;

        for (let i = 0; i < n; i++) {
            const xi = Math.min(bins - 1, Math.floor((x[i] - xMin) / xRange * bins));
            const yi = Math.min(bins - 1, Math.floor((y[i] - yMin) / yRange * bins));
            const key = `${xi},${yi}`;
            joint[key] = (joint[key] || 0) + 1;
            xHist[xi]++;
            yHist[yi]++;
        }

        // 计算互信息
        let mi = 0;
        for (const key in joint) {
            const [xi, yi] = key.split(',').map(Number);
            const pxy = joint[key] / n;
            const px = xHist[xi] / n;
            const py = yHist[yi] / n;
            if (pxy > 0 && px > 0 && py > 0) {
                mi += pxy * Math.log2(pxy / (px * py));
            }
        }

        return mi;
    }

    /**
     * 近似最大Lyapunov指数
     */
    _lyapunovExponent(signal) {
        if (signal.length < 100) return 0;

        const m = 3; // 嵌入维数
        const tau = 5; // 时间延迟
        const n = signal.length;
        const maxIter = Math.min(50, Math.floor((n - m * tau) / 2));

        if (maxIter < 10) return 0;

        // 相空间重构
        let sumLogDiv = 0;
        let count = 0;

        for (let i = 0; i < maxIter; i++) {
            const reference = i;
            let nearestIdx = -1;
            let nearestDist = Infinity;

            // 找最近邻（排除时间上太近的点）
            for (let j = 0; j < n - m * tau; j++) {
                if (Math.abs(j - reference) < m * tau) continue;
                let dist = 0;
                for (let k = 0; k < m; k++) {
                    const diff = signal[reference + k * tau] - signal[j + k * tau];
                    dist += diff * diff;
                }
                dist = Math.sqrt(dist);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = j;
                }
            }

            if (nearestIdx >= 0 && nearestDist > 1e-10 &&
                reference + m * tau < n && nearestIdx + m * tau < n) {
                // 演化一步
                let newDist = 0;
                for (let k = 0; k < m; k++) {
                    const diff = signal[reference + 1 + k * tau] - signal[nearestIdx + 1 + k * tau];
                    newDist += diff * diff;
                }
                newDist = Math.sqrt(newDist);

                if (newDist > 1e-10) {
                    sumLogDiv += Math.log(newDist / nearestDist);
                    count++;
                }
            }
        }

        return count > 0 ? sumLogDiv / count : 0;
    }

    // ====== 辅助工具 ======

    /**
     * 线性回归斜率
     */
    _linearSlope(x, y) {
        if (!y) {
            // 单数组模式：x是索引
            y = x;
            x = y.map((_, i) => i);
        }
        const n = x.length;
        if (n < 2) return 0;

        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

        const denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return 0;

        return (n * sumXY - sumX * sumY) / denom;
    }

    /**
     * 简化sway面积计算
     */
    _computeSwaySimple(data) {
        if (data.length < 10) return 0;
        const positions = [];
        let vx = 0, vy = 0, px = 0, py = 0;
        const dt = 1 / this.targetSampleRate;

        for (let i = 0; i < data.length; i++) {
            vx += data[i].x * dt;
            vy += data[i].y * dt;
            vx *= 0.99; vy *= 0.99;
            px += vx * dt;
            py += vy * dt;
            positions.push({ x: px, y: py });
        }

        let area = 0;
        for (let i = 0; i < positions.length; i++) {
            const j = (i + 1) % positions.length;
            area += positions[i].x * positions[j].y;
            area -= positions[j].x * positions[i].y;
        }
        return Math.abs(area) / 2;
    }

    /**
     * 估算频率（通过过零率）
     */
    _estimateFrequency(signal) {
        if (signal.length < 20) return 0;
        const mean = this._mean(signal);
        let crossings = 0;
        for (let i = 1; i < signal.length; i++) {
            if ((signal[i] - mean) * (signal[i - 1] - mean) < 0) crossings++;
        }
        const duration = signal.length / this.targetSampleRate;
        return duration > 0 ? crossings / (2 * duration) : 0;
    }

    /**
     * Jerk均值
     */
    _jerkMean(signal) {
        if (signal.length < 10) return 0;
        let sum = 0;
        for (let i = 2; i < signal.length; i++) {
            sum += Math.abs(signal[i] - 2 * signal[i - 1] + signal[i - 2]);
        }
        return sum / (signal.length - 2);
    }

    /**
     * 简化椭圆拟合（PCA方法）
     */
    _fitEllipse(positions) {
        if (positions.length < 10) return { area: 0, major: 0, minor: 0, orientation: 0 };

        const xs = positions.map(p => p.x);
        const ys = positions.map(p => p.y);
        const meanX = this._mean(xs);
        const meanY = this._mean(ys);

        // 协方差矩阵
        let cxx = 0, cyy = 0, cxy = 0;
        for (let i = 0; i < positions.length; i++) {
            const dx = positions[i].x - meanX;
            const dy = positions[i].y - meanY;
            cxx += dx * dx;
            cyy += dy * dy;
            cxy += dx * dy;
        }
        cxx /= positions.length;
        cyy /= positions.length;
        cxy /= positions.length;

        // 特征值（2x2对称矩阵）
        const trace = cxx + cyy;
        const det = cxx * cyy - cxy * cxy;
        const discriminant = Math.sqrt(Math.max(0, trace * trace / 4 - det));
        const lambda1 = trace / 2 + discriminant;
        const lambda2 = Math.max(0, trace / 2 - discriminant);

        // 方向角
        let orientation = 0;
        if (Math.abs(cxx - cyy) > 1e-10) {
            orientation = 0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI;
        } else if (cxy > 0) {
            orientation = 45;
        }

        const major = 2 * Math.sqrt(lambda1);
        const minor = 2 * Math.sqrt(lambda2);
        const area = Math.PI * major * minor / 4;

        return { area, major, minor, orientation };
    }
}
