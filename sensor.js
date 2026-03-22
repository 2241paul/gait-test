class SensorManager {
    constructor() {
        this.isRunning = false;
        this.data = [];
        this.accelerometerCallback = null;
        this.gyroscopeCallback = null;
        this.lastTimestamp = null;
    }

    // 检查传感器支持
    checkSensorSupport() {
        const supported = {
            accelerometer: 'Accelerometer' in window,
            gyroscope: 'Gyroscope' in window,
            deviceMotion: 'DeviceMotionEvent' in window
        };
        return supported;
    }

    // 请求传感器权限（iOS需要）
    async requestPermission() {
        if (typeof DeviceMotionEvent !== 'undefined' && 
            typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceMotionEvent.requestPermission();
                return permission === 'granted';
            } catch (error) {
                console.error('传感器权限请求失败:', error);
                return false;
            }
        }
        return true;
    }

    // 使用Generic Sensor API启动传感器
    startSensors() {
        this.isRunning = true;
        this.data = [];
        this.lastTimestamp = Date.now();

        // 尝试使用Generic Sensor API
        const supported = this.checkSensorSupport();
        
        if (supported.accelerometer) {
            try {
                const accelerometer = new Accelerometer({ frequency: 50 });
                accelerometer.onreading = () => {
                    this.handleReading(accelerometer, 'accelerometer');
                };
                accelerometer.onerror = (error) => {
                    console.error('加速度传感器错误:', error);
                };
                accelerometer.start();
                this.accelerometer = accelerometer;
            } catch (e) {
                console.warn('Generic Sensor API不可用，使用DeviceMotion');
            }
        }

        if (supported.gyroscope) {
            try {
                const gyroscope = new Gyroscope({ frequency: 50 });
                gyroscope.onreading = () => {
                    this.handleReading(gyroscope, 'gyroscope');
                };
                gyroscope.onerror = (error) => {
                    console.error('陀螺仪错误:', error);
                };
                gyroscope.start();
                this.gyroscope = gyroscope;
            } catch (e) {
                console.warn('陀螺仪Generic Sensor API不可用');
            }
        }

        // 回退到DeviceMotionEvent
        if (!this.accelerometer && !this.gyroscope) {
            window.addEventListener('devicemotion', this.handleDeviceMotion.bind(this));
        }

        return true;
    }

    // 处理Generic Sensor读数
    handleReading(sensor, type) {
        if (!this.isRunning) return;

        const timestamp = Date.now();
        let reading;

        if (type === 'accelerometer') {
            reading = {
                timestamp,
                type: 'accel',
                x: sensor.x,
                y: sensor.y,
                z: sensor.z
            };
        } else if (type === 'gyroscope') {
            reading = {
                timestamp,
                type: 'gyro',
                x: sensor.x,
                y: sensor.y,
                z: sensor.z
            };
        }

        this.data.push(reading);
    }

    // 处理DeviceMotionEvent读数
    handleDeviceMotion(event) {
        if (!this.isRunning) return;

        const timestamp = Date.now();
        const acc = event.acceleration;
        const accGravity = event.accelerationIncludingGravity;
        const rotation = event.rotationRate;

        if (acc) {
            this.data.push({
                timestamp,
                type: 'accel',
                x: acc.x || 0,
                y: acc.y || 0,
                z: acc.z || 0
            });
        }

        if (rotation) {
            this.data.push({
                timestamp,
                type: 'gyro',
                x: rotation.alpha || 0,
                y: rotation.beta || 0,
                z: rotation.gamma || 0
            });
        }
    }

    // 停止传感器
    stopSensors() {
        this.isRunning = false;

        if (this.accelerometer) {
            this.accelerometer.stop();
        }
        if (this.gyroscope) {
            this.gyroscope.stop();
        }

        window.removeEventListener('devicemotion', this.handleDeviceMotion.bind(this));
    }

    // 获取采集的数据
    getData() {
        return this.data;
    }

    // 按时间排序数据
    sortDataByTime() {
        this.data.sort((a, b) => a.timestamp - b.timestamp);
    }

    // 清空数据
    clearData() {
        this.data = [];
    }
}
