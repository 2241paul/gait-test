/**
 * SensorManager - 传感器管理模块
 * 支持100Hz采样率、坐标系归一化(ENu)、数据质量控制
 */
class SensorManager {
    constructor() {
        this.isRunning = false;
        this.data = [];
        this.startTime = null;
        this.targetFrequency = 100; // 100Hz
        this.apiType = 'none'; // 'generic' | 'devicemotion' | 'none'
        
        // Generic Sensor API实例
        this.accelerometer = null;
        this.gyroscope = null;
        
        // DeviceMotion原始数据缓冲
        this._dmAccelBuffer = [];
        this._dmGyroBuffer = [];
        this._dmAccelWithGravity = null;
        this._dmLastTimestamp = null;
        this._dmProcessingTimer = null;
        
        // 坐标系归一化
        this._orientationDetected = false;
        this._orientationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // 3x3 单位矩阵（行优先）
        
        // 质控参数
        this._samplingRateActual = 0;
        this._samplingTimestamps = [];
        this._signalSaturationCount = 0;
        this._totalDataPoints = 0;
        this._missingIntervals = 0;
        this._accelRangeMax = 20; // m/s², 大多数手机加速度计量程
        this._gyroRangeMax = 20; // rad/s
        
        // 磁力计
        this._magnetometer = null;
        this._hasMagnetometer = false;
        
        // 绑定函数引用
        this._boundHandleDeviceMotion = this._handleDeviceMotion.bind(this);
    }

    // ====== 公共接口 ======

    /**
     * 检查传感器支持情况
     */
    checkSensorSupport() {
        const supported = {
            accelerometer: 'Accelerometer' in window,
            gyroscope: 'Gyroscope' in window,
            magnetometer: 'Magnetometer' in window,
            deviceMotion: 'DeviceMotionEvent' in window
        };
        return supported;
    }

    /**
     * 请求传感器权限（iOS 13+需要）
     */
    async requestPermission() {
        // iOS DeviceMotion权限
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
                const motionPermission = await DeviceMotionEvent.requestPermission();
                if (motionPermission !== 'granted') return false;
            } catch (error) {
                console.error('DeviceMotion权限请求失败:', error);
                return false;
            }
        }
        
        // iOS Generic Sensor权限
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const results = await Promise.allSettled([
                    navigator.permissions.query({ name: 'accelerometer' }),
                    navigator.permissions.query({ name: 'gyroscope' }),
                    navigator.permissions.query({ name: 'magnetometer' })
                ]);
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value.state === 'denied') {
                        return false;
                    }
                }
            } catch (e) {
                // 某些浏览器不支持这些permission name，忽略
            }
        }
        
        return true;
    }

    /**
     * 启动传感器（向后兼容接口）
     * @returns {boolean}
     */
    startSensors() {
        return this._start();
    }

    /**
     * 停止传感器（向后兼容接口）
     */
    stopSensors() {
        this._stop();
    }

    /**
     * 获取采集的数据（向后兼容接口）
     * @returns {Array} 标准化数据数组
     */
    getData() {
        return this.data;
    }

    /**
     * 获取采样质量报告
     */
    getQualityReport() {
        const duration = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
        return {
            apiType: this.apiType,
            targetFrequency: this.targetFrequency,
            samplingRateActual: this._samplingRateActual,
            signalSaturationRate: this._totalDataPoints > 0
                ? (this._signalSaturationCount / this._totalDataPoints * 100)
                : 0,
            missingDataPoints: this._missingIntervals,
            totalDataPoints: this._totalDataPoints,
            orientationDetected: this._orientationDetected,
            hasMagnetometer: this._hasMagnetometer,
            duration: duration
        };
    }

    /**
     * 清空数据
     */
    clearData() {
        this.data = [];
        this._dmAccelBuffer = [];
        this._dmGyroBuffer = [];
        this._samplingTimestamps = [];
        this._signalSaturationCount = 0;
        this._totalDataPoints = 0;
        this._missingIntervals = 0;
        this._orientationDetected = false;
        this._orientationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        this.startTime = null;
    }

    // ====== 内部实现 ======

    /**
     * 启动传感器采集
     */
    _start() {
        if (this.isRunning) return false;
        
        this.isRunning = true;
        this.data = [];
        this._dmAccelBuffer = [];
        this._dmGyroBuffer = [];
        this._samplingTimestamps = [];
        this._signalSaturationCount = 0;
        this._totalDataPoints = 0;
        this._missingIntervals = 0;
        this._orientationDetected = false;
        this._orientationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        this.startTime = Date.now();
        
        const supported = this.checkSensorSupport();
        
        // 优先使用Generic Sensor API
        if (supported.accelerometer || supported.gyroscope) {
            this.apiType = 'generic';
            this._startGenericSensors(supported);
        } else if (supported.deviceMotion) {
            this.apiType = 'devicemotion';
            this._startDeviceMotion();
        } else {
            this.apiType = 'none';
            this.isRunning = false;
            console.error('无可用的传感器API');
            return false;
        }
        
        return true;
    }

    /**
     * 启动Generic Sensor API
     */
    _startGenericSensors(supported) {
        if (supported.accelerometer) {
            try {
                this.accelerometer = new Accelerometer({ frequency: this.targetFrequency });
                this.accelerometer.onreading = () => this._handleGenericReading(this.accelerometer, 'accel');
                this.accelerometer.onerror = (e) => {
                    console.error('加速度计错误:', e.error);
                    this._fallbackToDeviceMotion();
                };
                this.accelerometer.start();
            } catch (e) {
                console.warn('Generic Accelerometer启动失败:', e);
                this._fallbackToDeviceMotion();
            }
        }

        if (supported.gyroscope) {
            try {
                this.gyroscope = new Gyroscope({ frequency: this.targetFrequency });
                this.gyroscope.onreading = () => this._handleGenericReading(this.gyroscope, 'gyro');
                this.gyroscope.onerror = (e) => {
                    console.error('陀螺仪错误:', e.error);
                };
                this.gyroscope.start();
            } catch (e) {
                console.warn('Generic Gyroscope启动失败:', e);
            }
        }

        // 磁力计
        if (supported.magnetometer) {
            try {
                this._magnetometer = new Magnetometer({ frequency: 10 }); // 磁力计低频即可
                this._magnetometer.onreading = () => {
                    this._hasMagnetometer = true;
                    this._pushDataPoint('mag', this._magnetometer.x, this._magnetometer.y, this._magnetometer.z);
                };
                this._magnetometer.onerror = () => {};
                this._magnetometer.start();
            } catch (e) {
                this._hasMagnetometer = false;
            }
        }
    }

    /**
     * Generic Sensor API失败时回退到DeviceMotion
     */
    _fallbackToDeviceMotion() {
        if (this.apiType === 'devicemotion') return;
        console.log('回退到DeviceMotion API');
        
        // 停止Generic Sensor
        if (this.accelerometer) {
            try { this.accelerometer.stop(); } catch(e) {}
            this.accelerometer = null;
        }
        if (this.gyroscope) {
            try { this.gyroscope.stop(); } catch(e) {}
            this.gyroscope = null;
        }
        
        this.apiType = 'devicemotion';
        this._startDeviceMotion();
    }

    /**
     * 启动DeviceMotion事件监听
     * DeviceMotion通常60Hz，需要插值到100Hz
     */
    _startDeviceMotion() {
        window.addEventListener('devicemotion', this._boundHandleDeviceMotion);
        
        // 插值定时器：每10ms处理一次缓冲区，输出100Hz数据
        this._dmProcessingTimer = setInterval(() => {
            this._processDeviceMotionBuffer();
        }, 10); // 10ms = 100Hz
    }

    /**
     * 处理DeviceMotion原始事件（原始频率，存入缓冲区）
     */
    _handleDeviceMotion(event) {
        if (!this.isRunning) return;
        
        const now = performance.now();
        
        // 存储含重力的加速度（用于坐标系检测）
        const accG = event.accelerationIncludingGravity;
        if (accG) {
            this._dmAccelWithGravity = {
                x: accG.x || 0,
                y: accG.y || 0,
                z: accG.z || 0,
                t: now
            };
        }
        
        // 缓存线性加速度
        const acc = event.acceleration;
        if (acc && (acc.x !== null || acc.y !== null || acc.z !== null)) {
            this._dmAccelBuffer.push({
                x: acc.x || 0,
                y: acc.y || 0,
                z: acc.z || 0,
                t: now
            });
        }
        
        // 缓存陀螺仪
        const rot = event.rotationRate;
        if (rot && (rot.alpha !== null || rot.beta !== null || rot.gamma !== null)) {
            this._dmGyroBuffer.push({
                x: rot.beta || 0,   // beta = 前后倾斜
                y: rot.gamma || 0,  // gamma = 左右倾斜
                z: rot.alpha || 0,  // alpha = 偏航
                t: now
            });
        }
        
        // 限制缓冲区大小（保留最近200ms）
        const cutoff = now - 200;
        this._dmAccelBuffer = this._dmAccelBuffer.filter(d => d.t >= cutoff);
        this._dmGyroBuffer = this._dmGyroBuffer.filter(d => d.t >= cutoff);
    }

    /**
     * 处理DeviceMotion缓冲区，线性插值到100Hz
     */
    _processDeviceMotionBuffer() {
        if (!this.isRunning || !this.startTime) return;
        
        const now = performance.now();
        const t = (now - this.startTime) / 1000; // 秒
        
        // 线性插值加速度
        this._interpolateAndPush(this._dmAccelBuffer, now, t, 'accel');
        
        // 线性插值陀螺仪
        this._interpolateAndPush(this._dmGyroBuffer, now, t, 'gyro');
        
        // 用含重力加速度检测方向
        if (this._dmAccelWithGravity && !this._orientationDetected) {
            this._detectOrientationFromGravity(
                this._dmAccelWithGravity.x,
                this._dmAccelWithGravity.y,
                this._dmAccelWithGravity.z
            );
        }
    }

    /**
     * 线性插值并在目标时间点输出数据
     */
    _interpolateAndPush(buffer, now, t, type) {
        if (buffer.length < 2) return;
        
        // 找到最近的两个点进行插值
        let idx = buffer.length - 1;
        while (idx > 0 && buffer[idx].t > now) idx--;
        if (idx >= buffer.length - 1) return;
        
        const p0 = buffer[idx];
        const p1 = buffer[idx + 1];
        const dt = p1.t - p0.t;
        
        if (dt < 0.5) { // 避免除零，且间距过小说明数据有问题
            const alpha = dt > 0 ? (now - p0.t) / dt : 0.5;
            const x = p0.x + alpha * (p1.x - p0.x);
            const y = p0.y + alpha * (p1.y - p0.y);
            const z = p0.z + alpha * (p1.z - p0.z);
            this._pushDataPoint(type, x, y, z);
        }
    }

    /**
     * 停止传感器
     */
    _stop() {
        this.isRunning = false;
        
        // 停止Generic Sensor
        if (this.accelerometer) {
            try { this.accelerometer.stop(); } catch(e) {}
            this.accelerometer = null;
        }
        if (this.gyroscope) {
            try { this.gyroscope.stop(); } catch(e) {}
            this.gyroscope = null;
        }
        if (this._magnetometer) {
            try { this._magnetometer.stop(); } catch(e) {}
            this._magnetometer = null;
        }
        
        // 停止DeviceMotion
        window.removeEventListener('devicemotion', this._boundHandleDeviceMotion);
        if (this._dmProcessingTimer) {
            clearInterval(this._dmProcessingTimer);
            this._dmProcessingTimer = null;
        }
        
        // 计算实际采样率
        this._computeActualSamplingRate();
    }

    /**
     * 处理Generic Sensor API读数（已经是目标频率）
     */
    _handleGenericReading(sensor, type) {
        if (!this.isRunning || !this.startTime) return;
        
        let x, y, z;
        
        if (type === 'accel') {
            x = sensor.x || 0;
            y = sensor.y || 0;
            z = sensor.z || 0;
            
            // Generic Sensor API的Accelerometer不包含重力
            // 但我们可以利用初始几秒的平均值近似估计重力方向
            if (!this._orientationDetected && this.data.length > 100) {
                // 收集足够的accel数据后，用数据本身的分布来推断
                // 简单方法：假设手机竖直握持时z轴大致向上
                this._detectOrientationFromData();
            }
        } else {
            x = sensor.x || 0;
            y = sensor.y || 0;
            z = sensor.z || 0;
        }
        
        this._pushDataPoint(type, x, y, z);
    }

    /**
     * 从加速度数据分布检测手机方向（Generic Sensor API用）
     */
    _detectOrientationFromData() {
        const accelData = this.data.filter(d => d.type === 'accel');
        if (accelData.length < 100) return;
        
        // 假设手机静止时加速度均值约为重力方向
        // 行走时各轴均值趋于0，但方差不同
        // 简化策略：用screen orientation API辅助
        const orientation = screen.orientation ? screen.orientation.type : 
                          (window.orientation !== undefined ? 
                           (Math.abs(window.orientation) === 90 ? 'landscape' : 'portrait') : 'portrait');
        
        // 根据屏幕方向和设备类型估算坐标系映射
        const isPortrait = orientation.includes('portrait');
        
        // 标准手机竖握：
        //   设备X -> 物理：左右(设备左右)，映射到ENu的Y(左右)
        //   设备Y -> 物理：上下(设备上下)，映射到ENu的Z(上下) 或 -Z
        //   设备Z -> 物理：前后(屏幕朝向)，映射到ENu的X(前后)
        if (isPortrait) {
            // 竖屏：设备XYZ -> ENu的 YZX（取反Y使朝上为正）
            this._orientationMatrix = [
                0, 0, 1,  // ENu_X = 设备Z（前后）
                1, 0, 0,  // ENu_Y = 设备X（左右）
                0, -1, 0  // ENu_Z = -设备Y（向上为正）
            ];
        } else {
            // 横屏
            this._orientationMatrix = [
                0, 0, 1,  // ENu_X = 设备Z（前后）
                0, 1, 0,  // ENu_Y = 设备Y
                -1, 0, 0  // ENu_Z = -设备X
            ];
        }
        
        this._orientationDetected = true;
    }

    /**
     * 从重力加速度检测手机方向（DeviceMotion API用）
     * accelerationIncludingGravity的z分量判断重力方向
     */
    _detectOrientationFromGravity(gx, gy, gz) {
        const gMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gMag < 1.0) return; // 重力值异常，跳过
        
        // 重力单位向量
        const gn = { x: gx / gMag, y: gy / gMag, z: gz / gMag };
        
        // 判断哪个设备轴最接近竖直方向（|gravity| ≈ 9.8的轴）
        // 手机竖直握持时：
        //   iOS DeviceMotion：gravityY ≈ -9.8（屏幕朝用户），gravityZ ≈ 0
        //   Android DeviceMotion：gravityY ≈ -9.8
        // 手机水平放在桌上：
        //   gravityZ ≈ -9.8（屏幕朝上）
        
        const absX = Math.abs(gn.x);
        const absY = Math.abs(gn.y);
        const absZ = Math.abs(gn.z);
        
        // 确定哪个轴是"上下"（重力方向）
        let upAxis, upSign;
        if (absY >= absX && absY >= absZ) {
            upAxis = 1; // Y轴
            upSign = gn.y > 0 ? 1 : -1;
        } else if (absZ >= absX && absZ >= absY) {
            upAxis = 2; // Z轴
            upSign = gn.z > 0 ? 1 : -1;
        } else {
            upAxis = 0; // X轴
            upSign = gn.x > 0 ? 1 : -1;
        }
        
        // 构建从设备坐标系到ENu坐标系的变换矩阵
        // ENu: X=前后, Y=左右, Z=上下(向上为正)
        // DeviceMotion坐标系（iOS标准）：
        //   X=左右(正值向右), Y=前后(正值向屏幕内), Z=上下(正值向上)
        // Android也类似
        
        // 通用构建：根据重力方向推断
        // 重力沿Y轴（手机竖直握持，最常见）
        if (upAxis === 1) {
            // 设备Y轴≈重力方向（上下）
            // ENu_X = 设备Y(前后), ENu_Y = 设备X(左右), ENu_Z = 重力反方向(向上)
            this._orientationMatrix = [
                upSign, 0, 0,    // ENu_X
                0, 1, 0,        // ENu_Y = 设备X(左右)
                0, 0, -upSign   // ENu_Z = 重力反方向
            ];
        }
        // 重力沿Z轴（手机平放）
        else if (upAxis === 2) {
            // 设备Z轴≈重力方向
            // ENu_X = 设备X(前后), ENu_Y = 设备Y(左右), ENu_Z = 重力反方向
            this._orientationMatrix = [
                1, 0, 0,        // ENu_X
                0, 1, 0,        // ENu_Y
                0, 0, -upSign   // ENu_Z
            ];
        }
        // 重力沿X轴（罕见，手机侧放）
        else {
            this._orientationMatrix = [
                0, upSign, 0,
                0, 0, 1,
                -upSign, 0, 0
            ];
        }
        
        this._orientationDetected = true;
    }

    /**
     * 应用坐标系变换：设备坐标 -> ENu坐标
     * @param {number} x - 设备X
     * @param {number} y - 设备Y
     * @param {number} z - 设备Z
     * @returns {{x, y, z}} ENu坐标
     */
    _transformToENu(x, y, z) {
        const m = this._orientationMatrix;
        return {
            x: m[0] * x + m[1] * y + m[2] * z,
            y: m[3] * x + m[4] * y + m[5] * z,
            z: m[6] * x + m[7] * y + m[8] * z
        };
    }

    /**
     * 推入一个标准化数据点（经过坐标变换和质控）
     */
    _pushDataPoint(type, x, y, z) {
        if (!this.startTime) return;
        
        const now = Date.now();
        const t = (now - this.startTime) / 1000; // 从开始的秒数
        
        // 坐标变换（陀螺仪和加速度都需要）
        const transformed = this._transformToENu(x, y, z);
        
        // 质控：信号饱和检测
        const isSaturated = this._checkSaturation(transformed, type);
        
        const point = {
            timestamp: now,
            type: type,
            x: parseFloat(transformed.x.toFixed(4)),
            y: parseFloat(transformed.y.toFixed(4)),
            z: parseFloat(transformed.z.toFixed(4)),
            t: parseFloat(t.toFixed(4)),
            saturated: isSaturated
        };
        
        this.data.push(point);
        this._totalDataPoints++;
        if (isSaturated) this._signalSaturationCount++;
        
        // 记录采样时间戳（用于计算实际采样率）
        this._samplingTimestamps.push(now);
        // 只保留最近1000个用于统计
        if (this._samplingTimestamps.length > 1000) {
            this._samplingTimestamps.shift();
        }
    }

    /**
     * 检查信号饱和
     */
    _checkSaturation(point, type) {
        const range = type === 'gyro' ? this._gyroRangeMax : this._accelRangeMax;
        const threshold = range * 0.95; // 95%量程视为饱和
        return Math.abs(point.x) >= threshold ||
               Math.abs(point.y) >= threshold ||
               Math.abs(point.z) >= threshold;
    }

    /**
     * 计算实际采样率
     */
    _computeActualSamplingRate() {
        const timestamps = this._samplingTimestamps;
        if (timestamps.length < 10) {
            this._samplingRateActual = 0;
            return;
        }
        
        // 取最近的500个时间戳计算平均间隔
        const recent = timestamps.slice(-500);
        let totalInterval = 0;
        let count = 0;
        for (let i = 1; i < recent.length; i++) {
            const dt = recent[i] - recent[i - 1];
            if (dt > 0 && dt < 1000) { // 忽略异常大间隔
                totalInterval += dt;
                count++;
            }
        }
        
        if (count > 0) {
            this._samplingRateActual = parseFloat((1000 / (totalInterval / count)).toFixed(1));
        }
        
        // 检测缺失数据点（间隔>50ms认为有缺失）
        const expectedInterval = 1000 / this.targetFrequency; // 10ms
        for (let i = 1; i < recent.length; i++) {
            const dt = recent[i] - recent[i - 1];
            if (dt > expectedInterval * 3) { // 超过3倍期望间隔
                this._missingIntervals += Math.floor(dt / expectedInterval) - 1;
            }
        }
    }
}
