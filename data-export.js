/**
 * DataExport - 数据导出模块
 * 支持原始数据JSON导出、特征CSV导出、历史记录管理
 */
class DataExport {
    constructor() {
        this.storageKey = 'gaitomics_history';
        this.maxHistory = 200; // 最多保留200条记录
    }

    // ====== JSON导出 ======

    /**
     * 导出单次测试的原始数据为JSON
     * @param {Object} record - 测试记录对象
     * @param {string} filename - 文件名（不含扩展名）
     */
    exportRawDataJSON(record, filename = 'gait_raw_data') {
        const exportObj = {
            version: '1.0',
            app: 'GaitOmics',
            exportTime: new Date().toISOString(),
            record: {
                id: record.id || this._generateId(),
                timestamp: record.timestamp || new Date().toISOString(),
                duration: record.duration || 0,
                samplingRate: record.samplingRate || 100,
                deviceInfo: this._getDeviceInfo()
            },
            rawData: record.rawData || [],
            quality: record.quality || {}
        };

        const json = JSON.stringify(exportObj, null, 2);
        this._downloadFile(json, `${filename}.json`, 'application/json');
    }

    /**
     * 导出单次测试的特征数据为JSON
     * @param {Object} record - 测试记录对象
     * @param {string} filename - 文件名
     */
    exportFeaturesJSON(record, filename = 'gait_features') {
        const exportObj = {
            version: '1.0',
            app: 'GaitOmics',
            exportTime: new Date().toISOString(),
            record: {
                id: record.id || this._generateId(),
                timestamp: record.timestamp || new Date().toISOString(),
                duration: record.duration || 0
            },
            features: record.features || {},
            featureCount: record.featureCount || 0,
            mjPrediction: record.mjPrediction || {}
        };

        const json = JSON.stringify(exportObj, null, 2);
        this._downloadFile(json, `${filename}.json`, 'application/json');
    }

    // ====== CSV导出 ======

    /**
     * 导出单次测试的特征为CSV
     * @param {Object} record - 包含features的对象
     * @param {string} filename - 文件名
     */
    exportFeaturesCSV(record, filename = 'gait_features') {
        const features = record.features || {};
        const now = new Date().toISOString();

        // UTF-8 BOM头，确保Excel正确识别中文
        const bom = '\uFEFF';

        // 表头
        const headers = ['参数名', '参数值', '记录时间'];
        const rows = [headers.join(',')];

        // 按分类排序
        const categories = {
            '时域统计': ['acc', 'gyr'],
            '轴向分解': ['vert', 'ml', 'ap', 'x_peak', 'y_peak', 'z_peak'],
            '频域': ['fft', 'psd', 'spectral', 'dominant'],
            '步态专项': ['step_', 'stride_', 'stance_', 'swing_', 'sway_', 'jerk_', 'net_', 'total_length', 'directness', 'lateral_', 'forward_', 'rhythmicity', 'autocorr'],
            '非线性动力学': ['entropy', 'hurst', 'fractal', 'mutual_', 'power_spectral', 'lyapunov'],
            '时间分段': ['diff', 'quarter', 'trend'],
            '质控': ['signal_', 'noise_', 'missing_', 'sampling_', 'accelerometer_', 'temperature_', 'valid_']
        };

        // 已处理的key集合，避免重复
        const processedKeys = new Set();

        for (const [category, prefixes] of Object.entries(categories)) {
            for (const [key, value] of Object.entries(features)) {
                if (processedKeys.has(key)) continue;

                const matches = prefixes.some(p => key.startsWith(p) || key.includes(p));
                if (matches) {
                    const safeKey = `"${key}"`;
                    const safeValue = typeof value === 'string' ? `"${value}"` : value;
                    rows.push(`${safeKey},${safeValue},"${now}"`);
                    processedKeys.add(key);
                }
            }
        }

        // 处理未分类的参数
        for (const [key, value] of Object.entries(features)) {
            if (!processedKeys.has(key)) {
                const safeKey = `"${key}"`;
                const safeValue = typeof value === 'string' ? `"${value}"` : value;
                rows.push(`${safeKey},${safeValue},"${now}"`);
            }
        }

        // 添加mJOA预测
        if (record.mjPrediction) {
            rows.push('');
            rows.push('"mJOA评分","' + (record.mjPrediction.score || '') + '","' + now + '"');
            rows.push('"置信度","' + (record.mjPrediction.confidence || '') + '","' + now + '"');
            rows.push('"功能描述","' + (record.mjPrediction.description || '') + '","' + now + '"');
        }

        const csv = bom + rows.join('\n');
        this._downloadFile(csv, `${filename}.csv`, 'text/csv;charset=utf-8');
    }

    /**
     * 批量导出所有历史记录为CSV
     * 每行一条记录，列为各个特征参数
     * @param {string} filename - 文件名
     */
    exportAllHistoryCSV(filename = 'gaitomics_all_records') {
        const history = this.getHistory();
        if (history.length === 0) {
            alert('暂无历史记录可导出');
            return;
        }

        const bom = '\uFEFF';

        // 收集所有出现过的特征key
        const allKeys = new Set();
        const metaKeys = ['id', 'timestamp', 'duration', 'step_count', 'mj_score', 'mj_confidence'];

        history.forEach(record => {
            if (record.features) {
                Object.keys(record.features).forEach(k => allKeys.add(k));
            }
        });

        const featureKeys = Array.from(allKeys).sort();
        const headers = [...metaKeys, ...featureKeys];
        const rows = [headers.join(',')];

        history.forEach(record => {
            const row = [];
            row.push(`"${record.id || ''}"`);
            row.push(`"${record.timestamp || ''}"`);
            row.push(record.duration || 0);
            row.push(record.features?.step_count || 0);
            row.push(record.mjPrediction?.score || '');
            row.push(record.mjPrediction?.confidence || '');

            featureKeys.forEach(key => {
                const val = record.features?.[key];
                if (val === undefined || val === null) {
                    row.push('');
                } else if (typeof val === 'string') {
                    row.push(`"${val}"`);
                } else {
                    row.push(val);
                }
            });

            rows.push(row.join(','));
        });

        const csv = bom + rows.join('\n');
        this._downloadFile(csv, `${filename}.csv`, 'text/csv;charset=utf-8');
    }

    // ====== 历史记录管理 ======

    /**
     * 保存一条测试记录到localStorage
     * @param {Object} record - { rawData, features, featureCount, mjPrediction, duration, quality }
     * @returns {string} 记录ID
     */
    saveRecord(record) {
        const history = this.getHistory();
        const id = record.id || this._generateId();

        const savedRecord = {
            id,
            timestamp: new Date().toISOString(),
            duration: record.duration || 0,
            features: record.features || {},
            featureCount: record.featureCount || Object.keys(record.features || {}).length,
            mjPrediction: record.mjPrediction || {},
            quality: record.quality || {}
            // 不保存rawData到历史记录，太大会撑爆localStorage
            // 如需原始数据，使用exportRawDataJSON即时导出
        };

        history.push(savedRecord);

        // 限制历史记录数量
        while (history.length > this.maxHistory) {
            history.shift();
        }

        try {
            localStorage.setItem(this.storageKey, JSON.stringify(history));
        } catch (e) {
            // localStorage满时，删除最早的记录后重试
            console.warn('localStorage空间不足，清理旧记录:', e);
            history.shift();
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(history));
            } catch (e2) {
                console.error('无法保存历史记录:', e2);
            }
        }

        return id;
    }

    /**
     * 获取所有历史记录
     * @returns {Array}
     */
    getHistory() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('读取历史记录失败:', e);
            return [];
        }
    }

    /**
     * 获取最近N条历史记录
     * @param {number} count
     * @returns {Array}
     */
    getRecentRecords(count = 10) {
        const history = this.getHistory();
        return history.slice(-count);
    }

    /**
     * 根据ID获取单条记录
     * @param {string} id
     * @returns {Object|null}
     */
    getRecordById(id) {
        const history = this.getHistory();
        return history.find(r => r.id === id) || null;
    }

    /**
     * 删除一条记录
     * @param {string} id
     * @returns {boolean}
     */
    deleteRecord(id) {
        const history = this.getHistory();
        const idx = history.findIndex(r => r.id === id);
        if (idx === -1) return false;

        history.splice(idx, 1);
        localStorage.setItem(this.storageKey, JSON.stringify(history));
        return true;
    }

    /**
     * 清空所有历史记录
     */
    clearHistory() {
        localStorage.removeItem(this.storageKey);
    }

    /**
     * 获取历史记录数量
     * @returns {number}
     */
    getHistoryCount() {
        return this.getHistory().length;
    }

    // ====== 内部工具方法 ======

    /**
     * 生成唯一ID
     */
    _generateId() {
        return 'G' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    }

    /**
     * 获取设备信息
     */
    _getDeviceInfo() {
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform || '',
            screenWidth: window.screen.width,
            screenHeight: window.screen.height,
            devicePixelRatio: window.devicePixelRatio || 1
        };
    }

    /**
     * 触发文件下载
     * @param {string} content - 文件内容
     * @param {string} filename - 文件名
     * @param {string} mimeType - MIME类型
     */
    _downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // 清理
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }
}
