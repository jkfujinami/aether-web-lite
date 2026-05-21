const crypto = require('crypto');

// NATタイプ定義
const NAT_TYPES = {
    FULL_CONE: 0,
    PORT_RESTRICTED: 1,
    SYMMETRIC: 2
};

// 一般ユーザー環境の分布モデル
const DISTRIBUTION = {
    [NAT_TYPES.FULL_CONE]: 0.05,        // 5%: 設定の緩いルーター・UPnP有効
    [NAT_TYPES.PORT_RESTRICTED]: 0.75,  // 75%: 一般的な家庭用ルーター
    [NAT_TYPES.SYMMETRIC]: 0.20         // 20%: モバイル回線(CGNAT)、公共Wi-Fi
};

// ノード生成関数
function createNode() {
    const rand = Math.random();
    let cumulative = 0;
    for (const [type, prob] of Object.entries(DISTRIBUTION)) {
        cumulative += prob;
        if (rand <= cumulative) {
            return parseInt(type);
        }
    }
    return NAT_TYPES.PORT_RESTRICTED;
}

// 2ノード間の標準P2P接続(STUNのみ)の成否判定
function canConnectDirectly(nodeA, nodeB) {
    if (nodeA === NAT_TYPES.FULL_CONE || nodeB === NAT_TYPES.FULL_CONE) return true;
    if (nodeA === NAT_TYPES.PORT_RESTRICTED && nodeB === NAT_TYPES.PORT_RESTRICTED) return true;
    return false; // Symmetric絡みは失敗(Symmetric vs Symmetric, Symmetric vs Port-Restricted)
}

// シミュレーション実行関数
function runSimulation(swarmSize, iterations = 10000) {
    let baselineSuccess = 0;
    let wnSeaSuccess = 0;
    let turnSavings = 0;

    for (let i = 0; i < iterations; i++) {
        // スウォーム(P2Pネットワーク)の生成
        const swarm = Array.from({ length: swarmSize }, createNode);
        
        // ランダムに2ノードを選出
        const idxA = Math.floor(Math.random() * swarmSize);
        let idxB = Math.floor(Math.random() * swarmSize);
        while (idxA === idxB) {
            idxB = Math.floor(Math.random() * swarmSize);
        }
        
        const nodeA = swarm[idxA];
        const nodeB = swarm[idxB];

        // 1. ベースライン判定
        const directSuccess = canConnectDirectly(nodeA, nodeB);
        if (directSuccess) {
            baselineSuccess++;
            wnSeaSuccess++; // 直接繋がるならWN-SEAでも当然成功
        } else {
            // 2. WN-SEA判定 (直接繋がらない場合、スウォーム内にリレー可能なスーパーノードを探す)
            // スーパーノード条件: Full Coneであること
            const hasSupernode = swarm.some(node => node === NAT_TYPES.FULL_CONE);
            if (hasSupernode) {
                wnSeaSuccess++;
                turnSavings++;
            }
        }
    }

    return {
        swarmSize,
        iterations,
        baselineRate: ((baselineSuccess / iterations) * 100).toFixed(2) + '%',
        wnSeaRate: ((wnSeaSuccess / iterations) * 100).toFixed(2) + '%',
        turnReductionRate: ((turnSavings / (iterations - baselineSuccess)) * 100).toFixed(2) + '%'
    };
}

console.log("=== WN-SEA (NAT-Aware Supernode Routing) Simulation ===");
console.log(`NAT Distribution: Full Cone: ${DISTRIBUTION[NAT_TYPES.FULL_CONE]*100}%, Port-Restricted: ${DISTRIBUTION[NAT_TYPES.PORT_RESTRICTED]*100}%, Symmetric(CGNAT): ${DISTRIBUTION[NAT_TYPES.SYMMETRIC]*100}%`);
console.log("---------------------------------------------------------");

const scenarios = [5, 10, 20, 50, 100];
scenarios.forEach(size => {
    const result = runSimulation(size);
    console.log(`Swarm Size: ${size.toString().padStart(3, ' ')} | Baseline: ${result.baselineRate.padStart(6, ' ')} -> WN-SEA: ${result.wnSeaRate.padStart(6, ' ')} | TURN Reduction: ${result.turnReductionRate.padStart(7, ' ')}`);
});
