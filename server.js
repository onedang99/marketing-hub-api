const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase 설정 (환경 변수에서 가져오기)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iprrgdrlgkdbtshrnhgs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwcnJnZHJsZ2tkYnRzaHJuaGdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNTc5ODYsImV4cCI6MjA5MjkzMzk4Nn0.pmqkGcki5Ayq7gmJsuugFy4Q4fiP2Z1JE59gHK5j3K8';

// 미들웨어
app.use(cors());
app.use(express.json());

// ==================== Supabase 헬퍼 함수 ====================

async function supabaseGet(table, options = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}?select=*`;
    if (options.filter) {
        url += `&${options.filter}`;
    }
    if (options.order) {
        url += `&order=${options.order}`;
    }
    
    const response = await fetch(url, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });
    
    if (!response.ok) {
        throw new Error(`Supabase GET failed: ${response.statusText}`);
    }
    
    return await response.json();
}

async function supabaseInsert(table, data) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
    });
    
    if (!response.ok) {
        throw new Error(`Supabase INSERT failed: ${response.statusText}`);
    }
    
    return await response.json();
}

async function supabaseUpdate(table, id, data) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
    });
    
    if (!response.ok) {
        throw new Error(`Supabase UPDATE failed: ${response.statusText}`);
    }
    
    return await response.json();
}

async function supabaseDelete(table, id) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });
    
    if (!response.ok) {
        throw new Error(`Supabase DELETE failed: ${response.statusText}`);
    }
}

// ==================== API 엔드포인트 ====================

// 1. 추적 상품 목록 조회
app.get('/api/tracking-products', async (req, res) => {
    try {
        const products = await supabaseGet('tracking_products', { 
            order: 'created_at.desc' 
        });
        
        // snake_case를 camelCase로 변환
        const transformedProducts = products.map(p => ({
            id: p.id,
            programId: p.program_id,
            productName: p.product_name,
            keyword: p.keyword,
            productUrl: p.product_url,
            currentRank: p.current_rank,
            previousRank: p.previous_rank,
            status: p.status,
            createdAt: p.created_at,
            lastChecked: p.last_checked,
            productTitle: p.product_title,
            imageUrl: p.image_url
        }));
        
        res.json({ success: true, data: transformedProducts });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. 추적 상품 추가
app.post('/api/tracking-products', async (req, res) => {
    try {
        const { keyword, productUrl, productName, programId } = req.body;

        if (!keyword || !productUrl) {
            return res.status(400).json({ 
                success: false, 
                error: '키워드와 상품 URL은 필수입니다.' 
            });
        }

        const newProduct = {
            keyword,
            product_url: productUrl,
            product_name: productName || '상품명 미입력',
            program_id: programId || null,
            created_at: new Date().toISOString(),
            last_checked: null,
            current_rank: null,
            previous_rank: null,
            status: 'pending'
        };

        const [createdProduct] = await supabaseInsert('tracking_products', newProduct);

        // 즉시 첫 순위 체크
        try {
            const result = await crawlNaverRanking(keyword, productUrl);
            
            const updatedData = {
                current_rank: result.rank,
                previous_rank: result.rank,
                last_checked: new Date().toISOString(),
                status: 'tracking',
                product_title: result.title || null,
                image_url: result.image || null
            };
            
            const [updated] = await supabaseUpdate('tracking_products', createdProduct.id, updatedData);
            
            // 순위 이력 저장
            await saveRankingHistory(createdProduct.id, result.rank);
            
            res.json({ success: true, data: updated });
        } catch (crawlError) {
            console.error('Initial crawl error:', crawlError);
            await supabaseUpdate('tracking_products', newProduct.id, { status: 'error' });
            res.json({ success: true, data: createdProduct });
        }
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. 추적 상품 삭제
app.delete('/api/tracking-products/:id', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        await supabaseDelete('tracking_products', productId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. 순위 이력 조회
app.get('/api/ranking-history/:productId', async (req, res) => {
    try {
        const productId = parseInt(req.params.productId);
        const history = await supabaseGet('ranking_history', { 
            filter: `product_id=eq.${productId}`,
            order: 'checked_at.desc'
        });
        
        // snake_case를 camelCase로 변환
        const transformedHistory = history.map(h => ({
            id: h.id,
            productId: h.product_id,
            rank: h.rank,
            checkedAt: h.checked_at
        }));
        
        res.json({ success: true, data: transformedHistory });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. 수동 순위 체크
app.post('/api/check-ranking/:id', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const products = await supabaseGet('tracking_products', { 
            filter: `id=eq.${productId}` 
        });
        
        if (!products || products.length === 0) {
            return res.status(404).json({ success: false, error: '상품을 찾을 수 없습니다.' });
        }

        const product = products[0];
        
        try {
            const result = await crawlNaverRanking(product.keyword, product.product_url);
            
            const updatedData = {
                previous_rank: product.current_rank,
                current_rank: result.rank,
                last_checked: new Date().toISOString(),
                status: 'tracking',
                product_title: result.title || product.product_title,
                image_url: result.image || product.image_url
            };
            
            const [updated] = await supabaseUpdate('tracking_products', productId, updatedData);
            
            // 순위 이력 저장
            await saveRankingHistory(productId, result.rank);
            
            // snake_case를 camelCase로 변환
            const transformedData = {
                id: updated.id,
                programId: updated.program_id,
                productName: updated.product_name,
                keyword: updated.keyword,
                productUrl: updated.product_url,
                currentRank: updated.current_rank,
                previousRank: updated.previous_rank,
                status: updated.status,
                createdAt: updated.created_at,
                lastChecked: updated.last_checked,
                productTitle: updated.product_title,
                imageUrl: updated.image_url
            };
            
            res.json({ success: true, data: transformedData });
        } catch (crawlError) {
            console.error('Crawl error:', crawlError);
            await supabaseUpdate('tracking_products', productId, { status: 'error' });
            res.status(500).json({ success: false, error: crawlError.message });
        }
    } catch (error) {
        console.error('Error checking ranking:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. 대시보드 통계
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const products = await supabaseGet('tracking_products');
        
        // 급상승/급하락 계산
        const rankChanges = products
            .filter(p => p.current_rank && p.previous_rank)
            .map(p => ({
                ...p,
                change: p.previous_rank - p.current_rank
            }))
            .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

        const topRisers = rankChanges.filter(p => p.change > 0).slice(0, 5);
        const topFallers = rankChanges.filter(p => p.change < 0).slice(0, 5);

        res.json({
            success: true,
            data: {
                totalProducts: products.length,
                trackingProducts: products.filter(p => p.status === 'tracking').length,
                errorProducts: products.filter(p => p.status === 'error').length,
                topRisers,
                topFallers
            }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Programs API ====================

// 프로그램 목록 조회
app.get('/api/programs', async (req, res) => {
    try {
        const programs = await supabaseGet('programs', { order: 'id.asc' });
        
        // snake_case를 camelCase로 변환
        const transformedPrograms = programs.map(p => ({
            id: p.id,
            platform: p.platform,
            name: p.name,
            description: p.description,
            dailyRate: p.daily_rate,
            createdAt: p.created_at
        }));
        
        res.json({ success: true, data: transformedPrograms });
    } catch (error) {
        console.error('Error fetching programs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 프로그램 추가
app.post('/api/programs', async (req, res) => {
    try {
        const { platform, name, description, dailyRate } = req.body;
        
        if (!platform || !name || !dailyRate) {
            return res.status(400).json({ 
                success: false, 
                error: '플랫폼, 프로그램명, 하루 당 금액은 필수입니다.' 
            });
        }
        
        const newProgram = {
            platform,
            name,
            description: description || '',
            daily_rate: dailyRate,
            created_at: new Date().toISOString()
        };
        
        const [created] = await supabaseInsert('programs', newProgram);
        
        res.json({ 
            success: true, 
            data: {
                id: created.id,
                platform: created.platform,
                name: created.name,
                description: created.description,
                dailyRate: created.daily_rate,
                createdAt: created.created_at
            }
        });
    } catch (error) {
        console.error('Error creating program:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 프로그램 수정
app.patch('/api/programs/:id', async (req, res) => {
    try {
        const programId = parseInt(req.params.id);
        const { platform, name, description, dailyRate } = req.body;
        
        const updateData = {};
        if (platform) updateData.platform = platform;
        if (name) updateData.name = name;
        if (description !== undefined) updateData.description = description;
        if (dailyRate) updateData.daily_rate = dailyRate;
        
        const [updated] = await supabaseUpdate('programs', programId, updateData);
        
        res.json({ 
            success: true, 
            data: {
                id: updated.id,
                platform: updated.platform,
                name: updated.name,
                description: updated.description,
                dailyRate: updated.daily_rate,
                createdAt: updated.created_at
            }
        });
    } catch (error) {
        console.error('Error updating program:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 프로그램 삭제
app.delete('/api/programs/:id', async (req, res) => {
    try {
        const programId = parseInt(req.params.id);
        await supabaseDelete('programs', programId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting program:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. 모든 상품 순위 체크
app.post('/api/check-all-products', async (req, res) => {
    try {
        console.log('🔍 수동 순위 체크 시작');
        
        // 비동기로 실행 (응답은 즉시)
        checkAllProducts();
        
        res.json({ 
            success: true, 
            message: '순위 체크가 시작되었습니다. 잠시 후 새로고침하세요.' 
        });
    } catch (error) {
        console.error('Error starting check:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 유틸리티 함수 ====================

// Python 스크립트로 순위 조회
function crawlNaverRanking(keyword, productUrl) {
    return new Promise((resolve, reject) => {
        const python = spawn('python3', ['main.py', productUrl, keyword]);
        
        let dataString = '';
        let errorString = '';
        
        python.stdout.on('data', (data) => {
            dataString += data.toString();
        });
        
        python.stderr.on('data', (data) => {
            errorString += data.toString();
        });
        
        python.on('close', (code) => {
            if (code !== 0) {
                console.error('Python Error:', errorString);
                reject(new Error('Python 스크립트 실행 실패'));
                return;
            }
            
            try {
                const result = JSON.parse(dataString);
                
                if (result.success) {
                    resolve(result);
                } else {
                    reject(new Error(result.error || '순위 조회 실패'));
                }
            } catch (error) {
                console.error('JSON Parse Error:', error, dataString);
                reject(new Error('JSON 파싱 오류'));
            }
        });
        
        // 타임아웃 설정 (30초)
        setTimeout(() => {
            python.kill();
            reject(new Error('순위 조회 시간 초과'));
        }, 30000);
    });
}

// 순위 이력 저장
async function saveRankingHistory(productId, rank) {
    try {
        await supabaseInsert('ranking_history', {
            product_id: productId,
            rank: rank,
            checked_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error saving ranking history:', error);
    }
}

// 모든 추적 상품 순위 체크
async function checkAllProducts() {
    console.log('[Scheduler] 순위 체크 시작:', new Date().toISOString());
    
    try {
        const products = await supabaseGet('tracking_products');
        
        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            
            try {
                console.log(`[${i + 1}/${products.length}] ${product.keyword} 체크 중...`);
                
                const result = await crawlNaverRanking(product.keyword, product.product_url);
                
                const updatedData = {
                    previous_rank: product.current_rank,
                    current_rank: result.rank,
                    last_checked: new Date().toISOString(),
                    status: 'tracking',
                    product_title: result.title || product.product_title,
                    image_url: result.image || product.image_url
                };
                
                await supabaseUpdate('tracking_products', product.id, updatedData);
                await saveRankingHistory(product.id, result.rank);
                
                // 각 상품 체크 후 잠시 대기 (네이버 부하 방지)
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                console.error(`순위 체크 실패 [${product.keyword}]:`, error.message);
                await supabaseUpdate('tracking_products', product.id, { status: 'error' });
            }
        }
        
        console.log('[Scheduler] 순위 체크 완료:', new Date().toISOString());
        
    } catch (error) {
        console.error('[Scheduler] 에러:', error);
    }
}

// ==================== 스케줄러 설정 ====================

// 매일 11시에 자동 체크
cron.schedule('0 11 * * *', () => {
    console.log('[Scheduler] 11시 정기 순위 체크 시작');
    checkAllProducts();
});

// ==================== 헬스체크 엔드포인트 ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Marketing Hub API Server',
        status: 'running',
        endpoints: [
            'GET /api/tracking-products',
            'POST /api/tracking-products',
            'DELETE /api/tracking-products/:id',
            'GET /api/ranking-history/:productId',
            'POST /api/check-ranking/:id',
            'POST /api/check-all-products',
            'GET /api/dashboard-stats'
        ]
    });
});

// ==================== 서버 시작 ====================

app.listen(PORT, () => {
    console.log(`🚀 서버 실행: http://localhost:${PORT}`);
    console.log('📊 순위 추적 시스템 준비 완료');
    console.log('⏰ 스케줄러: 매일 11시 자동 체크');
    console.log('🔗 Supabase 연결: ' + SUPABASE_URL);
});
