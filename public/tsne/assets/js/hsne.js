
class HSNE {
    #nodeRadiusLarge = 15;
    #nodeRadiusSmall = 5;

    #colors = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"]    
    #margin = {top: 15, bottom: 15, left:15, right:15};

    constructor(svgID, parameters) {
        this.svg = d3.select(svgID);

        this.loading = document.getElementById("loading");
        
        // Scale 3 is the coarsest level; drilling down is possible until scale 1
        this.maxScale = 3;
        this.curScale = this.maxScale;
        // Coarsest scale the participant can return to; lower when starting at a deeper level
        this.topScale = this.maxScale;
        this.pending = false;

        // [this.nodes, this.links, this.idMap] = initGraph(nodes,links);

        this.layer1 = this.svg.append("g");
        this.width = this.svg.node().getBoundingClientRect().width;
        this.height = this.svg.node().getBoundingClientRect().height;

        this.origin = {
            "x": this.width / 2,
            "y": this.height / 2
        }

        this.interactions = new Array();
        this.appendInteraction("start");

        this.center_node = null;

        this.selected = [];

        this.stack    = [];

        const makeButton = (containerId, text, onclick) => {
            const container = document.getElementById(containerId);
            if (!container) return null;
            const button = Object.assign(document.createElement("button"), {
                textContent: text,
                className: "hsne-button",
                onclick
            });
            container.appendChild(button);
            return button;
        };
        this.levelLabel  = document.getElementById("levellabel");
        this.drillButton = makeButton("drillcontainer", "Drill down", () => this.drillDown());
        this.backButton  = makeButton("popstack", "Go back", () => this.popStack());
        this.clearButton = makeButton("clearcontainer", "Clear selection", () => {
            this.clearSelection();
            this.appendInteraction("clearselection");
        });
        this.resetButton = makeButton("resetcontainer", "Restore original view", () => this.resetView());

        this.qtype = parameters.qtype;
        this.qid   = parameters.id;
        this.correctindex = Number(parameters.correct);

        if (this.qtype === "point"){
            const shapes = [
                d3.symbolTriangle, 
                d3.symbolCross, 
                d3.symbolDiamond, 
                d3.symbolStar
            ]; 
            this.shape = shapes[this.correctindex];
        }        


    }

    addData(nodes,links,fname){
        this.nodes = nodes;

        this.idMap = new Map();
        this.nodes.forEach((n,index) => {
            n.id = n.id.toString();
            this.idMap.set(n.id, index)
        });
        this.fname = fname;
    }

    // Sync button states and the level indicator with the current state
    updateControls(){
        const atFinest = this.curScale <= 1;
        const atTop = this.stack.length < 1;
        if (this.drillButton) {
            this.drillButton.disabled = this.pending || atFinest;
            this.drillButton.textContent = atFinest ? "Finest level reached" : "Drill down";
        }
        if (this.backButton) this.backButton.disabled = this.pending;
        if (this.clearButton) this.clearButton.disabled = this.pending;
        if (this.resetButton) this.resetButton.disabled = this.pending || atTop;
        document.getElementById("popstack").style.display = atTop ? 'none' : 'block';
        if (this.levelLabel) {
            // Levels are numbered from the participant's starting level
            const level = this.topScale - this.curScale + 1;
            this.levelLabel.textContent = `Level ${level} of ${this.topScale}`;
        }
    }

    setPending(pending){
        this.pending = pending;
        this.loading.classList.toggle('display', pending);
        this.updateControls();
    }

    // Fetch the next level for the given landmarks; resolves to the new nodes, or null on failure
    queryNextLevel(landmarks){
        let ddata = {"ids": landmarks, "depth": this.curScale, "dname": this.fname};
        this.setPending(true);
        // Abort if the server does not answer, so the view never stays locked
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000);
        return fetch('https://hyperbolic.algo.cit.tum.de/query', {
            'method': 'POST',
            'headers': {"Content-Type": 'application/json'},
            'body': JSON.stringify(ddata),
            'signal': controller.signal
        })
        .then(response => {
            if (!response.ok) throw new Error(`Query failed with status ${response.status}`);
            return response.json();
        })
        .then(data => {
            const newNodes = data?.data?.nodes;
            // t-SNE needs a handful of points; very small subsets are not meaningful to show
            if (!Array.isArray(newNodes) || newNodes.length < 3) {
                this.showMessage("Selection too small to drill into. Try selecting more points.");
                return null;
            }
            return newNodes;
        })
        .catch(error => {
            console.error(error);
            this.showMessage("Could not load this selection. Try a different set of points.");
            return null;
        })
        .finally(() => {
            clearTimeout(timeout);
            this.setPending(false);
        });
    }

    drillDown(){
        // Ignore clicks while a request is in flight or at the lowest scale
        if (this.pending || this.curScale <= 1) return;

        let landmarks = this.layer1.selectAll(".hover-node").data().map(d => d.index);
        if (landmarks.length === 0) {
            this.showMessage("Select some points first.");
            return;
        }

        this.queryNextLevel(landmarks).then(newNodes => {
            if (!newNodes) return;
            // Only commit to the new level once the response is known to be valid
            this.stack.push(this.nodes);
            this.nodes = newNodes;
            this.curScale -= 1;
            this.process();
            this.clearSelection();
            this.draw();
            this.updateControls();
            this.appendInteraction("drilldown");
        });
    }

    // Start the participant at a lower level by drilling down on all points.
    // The resulting level becomes the top: "Go back" and "Restore original view" do not go above it.
    startAtLevel(level){
        const targetScale = this.maxScale - level + 1;
        if (!(level > 1) || targetScale < 1) return Promise.resolve();

        const step = () => {
            if (this.curScale <= targetScale) return Promise.resolve();
            return this.queryNextLevel(this.nodes.map(d => d.index)).then(newNodes => {
                if (!newNodes) return;
                this.nodes = newNodes;
                this.curScale -= 1;
                this.process();
                this.draw();
                return step();
            });
        };

        return step().then(() => {
            this.topScale = this.curScale;
            this.clearSelection();
            this.updateControls();
            this.appendInteraction(`start_level_${this.maxScale - this.curScale + 1}`);
        });
    }

    popStack(){
        if (this.pending || this.stack.length < 1) return;
        this.nodes = this.stack.pop();
        this.curScale += 1;
        this.clearSelection();
        this.draw();
        this.updateControls();
        this.appendInteraction("goback");
    }

    // Return to the top level of the hierarchy
    resetView(){
        if (this.pending || this.stack.length < 1) return;
        this.nodes = this.stack[0];
        this.stack = [];
        this.curScale = this.topScale;
        this.clearSelection();
        this.draw();
        this.updateControls();
        this.appendInteraction("reset");
    }

    clearSelection(){
        this.layer1.selectAll(".nodes").classed("hover-node", false);
        if (this.brush && this.brushLayer) this.brushLayer.call(this.brush.move, null);
    }

    showMessage(text){
        let msg = document.getElementById("hsne-message");
        if (!msg) {
            msg = Object.assign(document.createElement("div"), {id: "hsne-message"});
            msg.style.cssText = "font-size:12px;color:#b00;margin-top:6px;";
            document.getElementById("sidebar")?.appendChild(msg);
        }
        msg.textContent = text;
        clearTimeout(this.messageTimer);
        this.messageTimer = setTimeout(() => { msg.textContent = ""; }, 4000);
    }
    
    appendInteraction(e){
        this.interactions.push(
            {"time": Date.now().toString(), 
             "event": e}
        );
    }

    dumpJson(){
        return JSON.stringify(this.interactions);
    }

    process(){
        //TODO: Change aspect ratio to square
        let xextent = d3.extent(this.nodes, d => d.euclidean.x);
        let yextent = d3.extent(this.nodes, d => d.euclidean.y);

        let xscale = d3.scaleLinear().domain(xextent).range([this.#margin.left, this.width-this.#margin.right]);
        let yscale = d3.scaleLinear().domain(yextent).range([this.#margin.top, this.height-this.#margin.bottom]);

        this.nodes.forEach(d => {
            d.x = xscale(d.euclidean.x);
            d.y = yscale(d.euclidean.y);
            d.r = this.#nodeRadiusSmall;
        });

        console.log(this.nodes)
        
    }

    // draw(){
    //     // if(this.stack.length > 0){
    //     //     document.getElementById("popstack").style.display = 'block';
    //     // }else{
    //     //     document.getElementById("popstack").style.display = 'none';
    //     // }
    //     const symbol = d3.symbol().size(60)
    //     this.layer1.selectAll(".nodes")
    //         .data(this.nodes, d => d.id)
    //         .join(
    //             enter => enter.append("path")
    //                 .attr("class", "nodes")
    //                 .attr("d", d => symbol.type(
    //                         d.id === this.qid ? this.shape : d3.symbolCircle
    //                     )()
    //                 )
    //                 .attr("stroke", "black")
    //                 // .attr("fill", d => d.class ? this.#colors[Math.abs(d.class)] : this.#colors[0])
    //                 .attr("fill", this.#colors[0])
    //                 .attr("transform", d => `translate(${d.x}, ${d.y})`),
    //                 // .attr("cx", d => d.x)
    //                 // .attr("cy", d => d.y)
    //                 // .attr("r", d => d.r),
    //             update => update
    //                 .attr("cx", d => d.x)
    //                 .attr("cy", d => d.y)
    //                 .attr("fill", this.#colors[0]),
    //                 // .attr("fill", d => d.class ? this.#colors[Math.abs(d.class)] : this.#colors[0]), 
    //             exit => exit.remove()
    //         )
    //         .attr("id", d => {
    //             return "node_" + d.id;
    //         });
    // }

    draw() {
        const symbol = d3.symbol().size(60);

        // Normalize qids: allow scalar or array; store as Set of numbers
        const qids = new Set(
            (Array.isArray(this.qid) ? this.qid : [this.qid])
            .filter(v => v !== undefined && v !== null)
            .map(v => Number(v))
        );

        const nodes = this.layer1
            .selectAll("path.nodes")
            .data(this.nodes, d => d.id)   // join key: stable identifier
            .join(
            enter => enter.append("path")
                .attr("class", "nodes")
                .attr("stroke", d => qids.has(Number(d.id)) ? "black" : "black")
                .attr("stroke-width", d => qids.has(Number(d.id)) ? 2 : 1)
                .attr("fill", this.#colors[0]),
            update => update,
            exit => exit.remove()
            )
            // set DOM id consistently for both enter and update
            .attr("id", d => `node_${d.id}`)
            // update position for paths
            .attr("transform", d => `translate(${d.x}, ${d.y})`)
            // update symbol (in case qids/shape changes)
            .attr("d", d => symbol.type(
            qids.has(Number(d.id)) ? this.shape : d3.symbolCircle
            )());

        // const nodes = this.layer1.selectAll("g.node")
        // .data(this.nodes, d => d.id)
        // .join(enter => {
        //     const g = enter.append("g").attr("class", "node");
        //     g.append("path").attr("class", "halo");
        //     g.append("path").attr("class", "mark");
        //     return g;
        // });

        // nodes.attr("transform", d => `translate(${d.x},${d.y})`);

        // nodes.select("path.halo")
        // .attr("d", d => symbol.type(qids.has(+d.id) ? this.shape : d3.symbolCircle)())
        // .attr("fill", "none")
        // .attr("stroke", "white")
        // .attr("stroke-width", d => qids.has(+d.id) ? 6 : 0)
        // .attr("opacity", 0.95);

        // nodes.select("path.mark")
        // .attr("d", d => symbol.type(qids.has(+d.id) ? this.shape : d3.symbolCircle)())
        // .attr("fill", this.#colors[0])
        // .attr("stroke", "black")
        // .attr("stroke-width", 1.5);

        // raise the whole group for special points
        nodes.filter(d => qids.has(+d.id)).raise();
        this.brushLayer?.raise();


        }

    addZoom(){
        this.layer1.attr("transform", d3.zoomIdentity);
        this.zoom = d3.zoom()
            .scaleExtent([0.1, 10])
	        .on('zoom', e => {
                this.layer1.attr('transform', e.transform);
                this.layer1.selectAll(".nodes")
                    .attr("r", d => d.r / e.transform.k);
            });
        this.svg.call(this.zoom);
        this.svg.on("dblclick.zoom", null);        
        // this.svg.on("wheel.zoom", null);
        document.getElementById("visualization-container").addEventListener('wheel', () => this.appendInteraction("zoom"))
    }

    addHover(id_list){
        if (! id_list){
            id_list = [];
        }
        var tthis = this;
        this.layer1.selectAll(".nodes")
            .on("mouseenter", function(e,d) {
                if (!id_list.includes("node_" + d.id)) {
                    d3.select(this).attr("class", "nodes hover-node"); //function(){} syntax has a different "this" which is the svg element attached.
                }

                tthis.appendInteraction("hover");
            })
            .on("mouseleave", (e, d) => {
                this.layer1.selectAll(".nodes").filter(n => !id_list.includes("node_" + n.id))
                    .attr("class", "nodes default-node");
                
            });
    }

    makeCenter(x,y, k=1, duration=750){
        let t = d3.transition().duration(duration);
        this.svg.transition(t).call(
            this.zoom.transform, 
            d3.zoomIdentity.translate(x,y).scale(k)
        );
    }

    addDblClick(){
        this.svg.on("dblclick", e => {
            const transform = this.layer1.node().attributes.transform.value.toString();
            let floats = getFloatsFromString(transform);
            let x0 = floats[0];
            let y0 = floats[1];
            let k0 = floats[2];

            let xmove = this.origin.x + x0;
            let ymove = this.origin.y + y0;

            let [x,y] = d3.pointer(e);
            
            this.makeCenter(xmove - x, ymove-y, k0);

            this.appendInteraction("dblclick");


        });
    }

    addResetButton(){
        var resetButton = document.createElement("button")
        resetButton.classList.add("reset-button")
        document.getElementById("sidebar").appendChild(resetButton)
        resetButton.appendChild(document.createTextNode('Reset Visualization'));
        resetButton.onclick = () => {
            this.resetToDefault();
        }            
    }

    setToCenterNode(){
        const transform = this.layer1.node().attributes.transform.value.toString();
        let floats = getFloatsFromString(transform);
        let x0 = floats[0];
        let y0 = floats[1];
        let xmove = this.origin.x + x0;
        let ymove = this.origin.y + y0;
        let c_node = this.nodes[this.center_node];

        this.makeCenter(xmove-c_node.x, ymove-c_node.y, 1, 0);     
    }

    addBrush() {
        // Create (or reuse) a brush layer that stays above nodes
        if (!this.brushLayer) {
            this.brushLayer = this.svg.append("g")
            .attr("class", "brush-layer");

            // Optional but recommended: ensure the brush can start anywhere
            // and doesn't lose events to other elements.
            this.brushLayer.append("rect")
            .attr("class", "brush-hit")
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", this.width)
            .attr("height", this.height)
            .style("fill", "transparent")
            .style("pointer-events", "all");
        }

        const brush = this.brush = d3.brush()
            .extent([[0, 0], [this.width, this.height]])
            .on("brush", (e) => {
            if (!e.selection) return;

            const [[x0, y0], [x1, y1]] = e.selection;

            this.layer1.selectAll(".nodes")
                .classed("hover-node", d =>
                x0 <= d.x && d.x <= x1 && y0 <= d.y && d.y <= y1
                );
            })
            // A click without dragging clears the brush; also clear the marked points then
            .on("end", (e) => {
                if (!e.selection) {
                    this.layer1.selectAll(".nodes").classed("hover-node", false);
                }
            });

        // Attach brush to the brush layer (not the root svg)
        this.brushLayer.call(brush);

        // Keep brush overlay above nodes (important if you raise nodes elsewhere)
        this.brushLayer.raise();
    }
    interact(id_list){
        this.layer1.on("click", () => {
            this.appendInteraction("pan");
        })
        // this.addZoom();
        this.addBrush();
        this.updateControls();
        this.addHover(id_list);
        this.addDblClick();
        // this.addResetButton();

        if (this.center_node !== null){
            this.setToCenterNode();
        }
    }

    highlight_question(id_list) {
        this.layer1.selectAll(".nodes").filter(n => id_list.includes("node_" + n.id))
            .attr("class", "nodes question-node")
            .attr("r", d => d.r = this.#nodeRadiusLarge);

    }

    resetToDefault(){
        this.svg.call(this.zoom.transform, d3.zoomIdentity);
        // if(this.center_node){
        //     this.setToCenterNode();
        // }

        this.appendInteraction("reset");
    }
}