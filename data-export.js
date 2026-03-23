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
     * 导出三次测试+平均值的特征为CSV（宽表格式）
     * 列：参数名 | 第1次 | 第2次 | 第3次 | 平均值
     *
     * @param {Object[]} tripleFeatures - 长度3的数组，每项为单次features对象（null表示未测）
     * @param {Object}   avgFeatures    - 平均值features对象
     * @param {string}   filename       - 文件名（不含扩展名）
     * @param {Object}   patientInfo    - 患者信息（可选）
     * @param {boolean}  noDownload     - 若为true，只返回csv文本，不触发文件下载
     * @returns {string} csv文本内容（用于邮件发送）
     */
    exportFeaturesCSV(tripleFeatures, avgFeatures, filename = 'gait_features', patientInfo = null, noDownload = false) {
        // UTF-8 BOM头，确保Excel正确识别中文
        const bom = '\uFEFF';
        const rows = [];

        // ── 患者信息区 ──
        if (patientInfo) {
            rows.push('"患者信息","","","",""');
            if (patientInfo.name)      rows.push(`"姓名","${patientInfo.name}","","",""`);
            if (patientInfo.gender)    rows.push(`"性别","${patientInfo.gender}","","",""`);
            if (patientInfo.age)       rows.push(`"年龄","${patientInfo.age}","","",""`);
            if (patientInfo.id)        rows.push(`"住院号","${patientInfo.id}","","",""`);
            if (patientInfo.diagnosis) rows.push(`"初步诊断","${patientInfo.diagnosis}","","",""`);
            rows.push('');
        }

        // ── 表头 ──
        rows.push('"参数名","第1次","第2次","第3次","平均值"');

        // ── 按分类收集所有参数key ──
        const categoryPrefixes = {
            '时域统计':     ['acc', 'gyr'],
            '轴向分解':     ['vert', 'ml', 'ap', 'x_peak', 'y_peak', 'z_peak'],
            '频域':         ['fft', 'psd', 'spectral', 'dominant'],
            '步态专项':     ['step_', 'stride_', 'stance_', 'swing_', 'sway_', 'jerk_',
                            'net_', 'total_length', 'directness', 'lateral_', 'forward_',
                            'rhythmicity', 'autocorr', 'acc_sway_'],
            '非线性动力学': ['entropy', 'hurst', 'fractal', 'mutual_', 'power_spectral', 'lyapunov'],
            '时间分段':     ['diff', 'quarter', 'trend'],
            '质控':         ['signal_', 'noise_', 'missing_', 'sampling_',
                            'accelerometer_', 'temperature_', 'valid_']
        };

        // 收集全部key（来自所有次 + 平均值）
        const allKeys = new Set();
        tripleFeatures.forEach(f => { if (f) Object.keys(f).forEach(k => allKeys.add(k)); });
        if (avgFeatures) Object.keys(avgFeatures).forEach(k => allKeys.add(k));

        // 格式化单个值
        const fmt = (val) => {
            if (val === undefined || val === null) return '';
            if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`;
            if (typeof val === 'number') return isFinite(val) ? val : '';
            return `"${String(val)}"`;
        };

        // 输出一行参数数据
        const writeRow = (key) => {
            const v1  = fmt(tripleFeatures[0]?.[key]);
            const v2  = fmt(tripleFeatures[1]?.[key]);
            const v3  = fmt(tripleFeatures[2]?.[key]);
            const avg = fmt(avgFeatures?.[key]);
            rows.push(`"${key}",${v1},${v2},${v3},${avg}`);
        };

        const processedKeys = new Set();

        // 按分类顺序输出
        for (const [category, prefixes] of Object.entries(categoryPrefixes)) {
            let catWritten = false;
            for (const key of allKeys) {
                if (processedKeys.has(key)) continue;
                const matches = prefixes.some(p => key.startsWith(p) || key.includes(p));
                if (matches) {
                    if (!catWritten) {
                        rows.push(`"【${category}】","","","",""`);
                        catWritten = true;
                    }
                    writeRow(key);
                    processedKeys.add(key);
                }
            }
        }

        // 未分类参数
        let uncatWritten = false;
        for (const key of allKeys) {
            if (!processedKeys.has(key)) {
                if (!uncatWritten) {
                    rows.push('"【其他参数】","","","",""');
                    uncatWritten = true;
                }
                writeRow(key);
            }
        }

        const csv = bom + rows.join('\n');
        if (!noDownload) {
            this._downloadFile(csv, `${filename}.csv`, 'text/csv;charset=utf-8');
        }
        return csv;
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
