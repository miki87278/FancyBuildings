var fs = require('fs')
var transformers = require('./transformers.js')
var {overlap, replaceAt, calcOffset} = require('./utils.js')
const { FLOOR_COUNT, SIDE_EFFECT_REGULARIZATION } = require('./parametrization.js')
const InnerWallWorker = require('./innerWallWorker.js')

class Feature {
    constructor(structure, requirements, projection, name) {
        this.name = name
        this.structure = structure
        this.requirements = requirements
        this.projection = overlap(
            JSON.parse(JSON.stringify(requirements).replace(/\*/g, "?")), 
            projection,
            calcOffset(this.requirements, projection)[0],
            calcOffset(this.requirements, projection)[1]
        )
    }

    clone_with_transform(transformer) {
        return new Feature(
            this.structure.map(slice => transformer(slice)), 
            transformer(this.requirements), 
            transformer(this.projection), 
            this.name+" ("+transformer.name.replace(/_/g, " ").replace("bound ", "")+")"
        )
    }

    hash() {
        return JSON.stringify([this.structure, this.requirements, this.projection])
    }

    static load() {
        let features = []
        for (let file of fs.readdirSync('src/structure/features')) {
            let raw = JSON.parse(fs.readFileSync('src/structure/features/' + file))
            let feature = new Feature(raw.slices, raw.requirements, raw.projection, file.split('.')[0])
            features.push(feature)

            let flagMap = {}
            flagMap[feature.hash()] = true
            for(let t of transformers) {
                let sub_feature = feature.clone_with_transform(t)
                if(flagMap[sub_feature.hash()]) continue
                flagMap[sub_feature.hash()] = true
                features.push(sub_feature)
            }
        }
        return features
    }

    get size() {
        return [this.requirements[0].length, this.requirements.length]
    }

    matches(projection, x, y) {
        if(x+this.requirements[0].length > projection[0].length) return {result: false}
        if(y+this.requirements.length > projection.length) return {result: false}
        let sideEffects = [0, 0]

        for(let i=0;i<this.requirements.length;i++) {
            for(let j=0;j<this.requirements[i].length;j++) {
                let req = this.requirements[i][j]
                let state = projection[y+i][x+j]
                
                if(req == "*" || req == state) continue
                if(state == "?") {
                    sideEffects[(req==" ")*1]++
                    continue
                }
                return {result: false}
            }
        }
        return {result: true, sideEffects}
    }

    make_ref(x, y) {
        return new FeatureRef(this, x, y)
    }
}
function postProcess(block) {
    const blockMapping = {
        "1": ()=>{return Math.floor(Math.random()*8+1)},
    }
    if(!blockMapping[block]) return block
    return blockMapping[block]()
}
class FeatureRef {
    constructor(feature, x, y) {
        this.feature = feature
        this.x = x
        this.y = y
        
        this.lastCheck = 0
        this.valid = true
    }
    get size() {return this.feature.size}
    get projection() {return this.feature.projection}
    get structure() {return this.feature.structure}
    get name() {return this.feature.name}
    matches(projection) {
        let result = this.feature.matches(projection, this.x, this.y)
        if(!result.result) return false

        this.sideEffects = result.sideEffects
        return true
    }

    overlap(floor) {
        overlap(floor.projection, this.projection, this.x, this.y)
        let offset = calcOffset(this.projection, this.structure[0])
        for(let i of [0, 1, 2]) {
            overlap(floor.structure[i*1+1], this.structure[i], this.x+offset[0], this.y+offset[1], false, postProcess)
        }
    }
}
const features = Feature.load()

class WaveWorker {
    constructor(buildingBase) {
        this.floor = buildingBase.make_floor()
        this.lastCheck = 0
    }

    prepareWaveMap() {
        this.waveMap = []
        for(let y=0;y<this.floor.structure[0].length;y++) {
            let row = []
            for(let x=0;x<this.floor.structure[0][0].length;x++) {
                let cell = []
                for(let f=0;f<features.length;f++) {
                    let ref = features[f].make_ref(x, y)
                    if(ref.matches(this.floor.projection))
                        cell.push(ref)
                }
                row.push(cell)
            }
            this.waveMap.push(row)
        }

        for(let y=this.floor.structure[0].length-1;y>=0;y--) {
            for(let x=this.floor.structure[0][0].length-1;x>=0;x--) {
                for(let f=0;f<this.waveMap[y][x].length;f++) {
                    let feature = this.waveMap[y][x][f]
                    for(let ox=0;ox<feature.size[0];ox++) {
                        for(let oy=0;oy<feature.size[1];oy++) {
                            if(ox==0 && oy==0) continue
                            this.waveMap[y+oy][x+ox].push(feature)
                        }
                    }
                }
            }
        }
    }

    pickFeature() {
        let minCandidates = []
        let min = Infinity
        for(let y=0;y<this.waveMap.length;y++) {
            for(let x=0;x<this.waveMap[y].length;x++) {
                let candidates = this.waveMap[y][x].filter(f => Math.random()>SIDE_EFFECT_REGULARIZATION(...f.sideEffects))
                if(candidates.length == 0) continue
                if(candidates.length < min) {
                    min = candidates.length
                    minCandidates = []
                }
                if(candidates.length == min)
                    minCandidates = minCandidates.concat(candidates)
            }
        }

        if (minCandidates.length == 0) return null
        let feature = minCandidates[Math.floor(Math.random()*minCandidates.length)]
        return feature
    }

    updateWaveMap() {
        this.lastCheck += 1
        for(let y=0;y<this.waveMap.length;y++) {
            for(let x=0;x<this.waveMap[y].length;x++) {
                for(let f=0;f<this.waveMap[y][x].length;f++) {
                    let feature = this.waveMap[y][x][f]
                    if(feature.lastCheck != this.lastCheck) {
                        feature.lastCheck = this.lastCheck
                        if(!feature.matches(this.floor.projection)) 
                            feature.valid = false
                    }
                    if(!feature.valid) {
                        this.waveMap[y][x].splice(f, 1)
                        f--
                    }
                }
            }
        }
    }

    cleanUpStructure() {
        for(let y=0;y<this.floor.projection.length;y++) this.floor.projection[y] = this.floor.projection[y].replace(/\?/g, " ")

        for(let i of [1, 2, 3]) {
            for(let y=0;y<this.floor.structure[i].length;y++) {
                for(let x=0;x<this.floor.structure[i][y].length;x++) {
                    if(this.floor.structure[i][y][x] != "?") continue 
                    let newChar = this.floor.projection[y][x]==" "?" ":"#"
                    this.floor.structure[i][y] = replaceAt(this.floor.structure[i][y], x, newChar)
                }
            }
        }
    }

    generate() {
        let worker = new InnerWallWorker(this.floor.structure, this.floor.projection)
        worker.apply()
        this.prepareWaveMap()
        let feature
        while((feature = this.pickFeature()) != null) {
            feature.overlap(this.floor)
            feature.valid = false
            this.updateWaveMap()
        }
        this.cleanUpStructure()
        return this.floor
    }

}

function logNow(arg) {
    console.log(JSON.parse(JSON.stringify(arg)))
}

function generate_floors(building) {
    let generatedFloors = []
    for(let _=0;_<FLOOR_COUNT;_++) {
        let floor = new WaveWorker(building).generate()
        generatedFloors.push(floor)
    }
    return generatedFloors
}

module.exports = generate_floors