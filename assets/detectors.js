(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PageGeneratorDetectors = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function colorDistance(data, offset, seed) {
        return Math.abs(data[offset] - seed[0]) + Math.abs(data[offset + 1] - seed[1]) + Math.abs(data[offset + 2] - seed[2]);
    }

    function luminance(color) {
        return color[0] * .299 + color[1] * .587 + color[2] * .114;
    }

    function saturation(color) {
        return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
    }

    function hex(color) {
        return '#' + color.map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    }

    // Connected regions of one flat colour: cards, inputs, buttons and badges are all such surfaces.
    function detectSurfaces(data, width, height, options) {
        var tolerance = options && options.tolerance || 10;
        var minPixels = options && options.minPixels || 300;
        var labels = new Int32Array(width * height);
        var stack = new Int32Array(width * height);
        var regions = [];
        for (var start = 0; start < labels.length; start += 1) {
            if (labels[start]) continue;
            var seedOffset = start * 4;
            var seed = [data[seedOffset], data[seedOffset + 1], data[seedOffset + 2]];
            var id = regions.length + 1;
            var top = 0;
            var count = 0;
            var minX = width; var maxX = 0; var minY = height; var maxY = 0;
            stack[top++] = start;
            labels[start] = id;
            while (top) {
                var index = stack[--top];
                var x = index % width;
                var y = (index - x) / width;
                count += 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x > 0 && !labels[index - 1] && colorDistance(data, (index - 1) * 4, seed) <= tolerance) { labels[index - 1] = id; stack[top++] = index - 1; }
                if (x < width - 1 && !labels[index + 1] && colorDistance(data, (index + 1) * 4, seed) <= tolerance) { labels[index + 1] = id; stack[top++] = index + 1; }
                if (y > 0 && !labels[index - width] && colorDistance(data, (index - width) * 4, seed) <= tolerance) { labels[index - width] = id; stack[top++] = index - width; }
                if (y < height - 1 && !labels[index + width] && colorDistance(data, (index + width) * 4, seed) <= tolerance) { labels[index + width] = id; stack[top++] = index + width; }
            }
            regions.push({ id: id, color: seed, count: count, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
        }
        var surfaces = regions.filter(function (region) {
            var area = region.width * region.height;
            return region.count >= minPixels && region.width >= 24 && region.height >= 12 &&
                region.count / area >= .45 && !(region.width >= width * .98 && region.height >= height * .98);
        }).map(function (region) {
            var inside = function (px, py) {
                return labels[py * width + px] === region.id;
            };
            var right = region.x + region.width - 1;
            var bottom = region.y + region.height - 1;
            var rounded = [
                inside(region.x, region.y), inside(right, region.y), inside(region.x, bottom), inside(right, bottom)
            ].filter(function (value) { return !value; }).length >= 3;
            return {
                x: region.x, y: region.y, width: region.width, height: region.height,
                fill: region.color, background: hex(region.color), rounded: rounded ? 6 : 0,
                solidity: region.count / (region.width * region.height)
            };
        });
        surfaces.forEach(function (surface, index) {
            var parent = null;
            surfaces.forEach(function (other, otherIndex) {
                if (otherIndex === index) return;
                var contains = other.x <= surface.x + 1 && other.y <= surface.y + 1 &&
                    other.x + other.width >= surface.x + surface.width - 1 &&
                    other.y + other.height >= surface.y + surface.height - 1 &&
                    other.width * other.height > surface.width * surface.height * 1.1;
                if (contains && (!parent || other.width * other.height < parent.width * parent.height)) parent = other;
            });
            surface.parent = parent ? surfaces.indexOf(parent) : -1;
        });
        return surfaces;
    }

    function ringSamples(surface, data, width, height) {
        var gap = Math.min(12, Math.max(4, Math.round(Math.min(surface.width, surface.height) * .1)));
        var samples = [];
        var sample = function (x, y) {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            var offset = (y * width + x) * 4;
            samples.push([data[offset], data[offset + 1], data[offset + 2]]);
        };
        var step = Math.max(1, Math.floor((surface.width + surface.height) / 80));
        for (var x = surface.x; x < surface.x + surface.width; x += step) {
            sample(x, surface.y - gap);
            sample(x, surface.y + surface.height + gap - 1);
        }
        for (var y = surface.y; y < surface.y + surface.height; y += step) {
            sample(surface.x - gap, y);
            sample(surface.x + surface.width + gap - 1, y);
        }
        return samples;
    }

    function median(samples) {
        if (!samples.length) return [255, 255, 255];
        return [0, 1, 2].map(function (channel) {
            var values = samples.map(function (color) { return color[channel]; }).sort(function (a, b) { return a - b; });
            return values[Math.floor(values.length / 2)];
        });
    }

    // Share of pixels just outside the box that match the surrounding surface (separates real plates from photo patches).
    function surroundMatch(samples, fill) {
        if (!samples.length) return 0;
        return samples.filter(function (color) {
            return Math.abs(color[0] - fill[0]) + Math.abs(color[1] - fill[1]) + Math.abs(color[2] - fill[2]) <= 36;
        }).length / samples.length;
    }

    // Geometry and colour only; nothing here reads text. Sizes are relative to page width (screenshots may be 2x).
    function classifySurfaces(surfaces, pageWidth, data, height) {
        var unit = pageWidth / 100;
        surfaces.forEach(function (surface) {
            var parent = surface.parent >= 0 ? surfaces[surface.parent] : null;
            var samples = data ? ringSamples(surface, data, pageWidth, height) : [];
            var parentFill = parent ? parent.fill : median(samples);
            var contrast = Math.abs(luminance(surface.fill) - luminance(parentFill)) + (saturation(surface.fill) - saturation(parentFill)) * .5;
            var colorStep = Math.abs(surface.fill[0] - parentFill[0]) + Math.abs(surface.fill[1] - parentFill[1]) + Math.abs(surface.fill[2] - parentFill[2]);
            var ratio = surface.width / surface.height;
            var around = data ? surroundMatch(samples, parentFill) : 1;
            surface.kind = 'surface';
            if (around < .6) return;
            if (surface.height >= unit * 1.1 && surface.height <= unit * 4.2 && surface.width <= unit * 22 && ratio >= 1.8 &&
                contrast >= 12 && surface.rounded && surface.width * surface.height <= unit * unit * 70) {
                surface.kind = 'badge';
            } else if (surface.height >= unit * 2.3 && surface.height <= unit * 9 && surface.width >= unit * 6 && ratio >= 1.8 &&
                contrast >= 70 && saturation(surface.fill) >= 60) {
                surface.kind = 'button';
            } else if (surface.height >= unit * 2.5 && surface.height <= unit * 24 && surface.width >= unit * 12 && ratio >= 3 &&
                contrast >= 3 && contrast < 60 && parent && luminance(parentFill) >= 230) {
                surface.kind = 'input-candidate';
            } else if (surface.height >= unit * 5 && surface.width >= unit * 25 && luminance(surface.fill) >= 235 && colorStep >= 9) {
                surface.kind = 'card';
            }
        });
        // An input is only trusted when similar fields repeat in one column.
        surfaces.forEach(function (surface) {
            if (surface.kind !== 'input-candidate') return;
            var siblings = surfaces.filter(function (other) {
                return other !== surface && other.kind === 'input-candidate' && other.parent === surface.parent &&
                    Math.abs(other.x - surface.x) <= unit && Math.abs(other.width - surface.width) <= unit;
            });
            if (!siblings.length) surface.kind = 'surface';
        });
        surfaces.forEach(function (surface) {
            if (surface.kind === 'input-candidate') surface.kind = 'input';
        });
        return surfaces;
    }

    // Short same-height lines on a common x or y axis with even spacing are a menu, whatever they say.
    function detectLineRuns(lines) {
        var usable = lines.filter(function (line) { return line.width <= 360 && line.height >= 8; });
        var runs = [];
        ['column', 'row'].forEach(function (axis) {
            var groups = [];
            usable.slice().sort(function (a, b) { return axis === 'column' ? a.y - b.y : a.x - b.x; }).forEach(function (line) {
                var group = groups.find(function (candidate) {
                    var last = candidate[candidate.length - 1];
                    var sameAxis = axis === 'column' ? Math.abs(last.x - line.x) <= 6 : Math.abs((last.y + last.height / 2) - (line.y + line.height / 2)) <= 6;
                    var similarSize = Math.abs(last.height - line.height) <= Math.max(8, last.height * .5);
                    var gap = axis === 'column' ? line.y - (last.y + last.height) : line.x - (last.x + last.width);
                    return sameAxis && similarSize && gap > 0 && gap <= (axis === 'column' ? 60 : 160);
                });
                if (group) group.push(line); else groups.push([line]);
            });
            groups.forEach(function (group) {
                if (group.length < 3) return;
                var steps = [];
                for (var index = 1; index < group.length; index += 1) {
                    steps.push(axis === 'column' ? group[index].y - group[index - 1].y : group[index].x - group[index - 1].x);
                }
                var mean = steps.reduce(function (sum, value) { return sum + value; }, 0) / steps.length;
                var even = axis === 'column'
                    ? steps.every(function (step) { return Math.abs(step - mean) <= Math.max(6, mean * .25); })
                    : steps.every(function (step) { return step > 0; });
                if (even) runs.push({ axis: axis, items: group });
            });
        });
        return runs;
    }

    // UI regions are dominated by a few flat colours; photos are not. Measured: photo ~0.45, UI >= 0.93.
    function dominantShare(data, width, box) {
        var bins = new Map();
        var total = 0;
        var step = Math.max(1, Math.floor(Math.min(box.width, box.height) / 60));
        for (var y = box.y; y < box.y + box.height; y += step) {
            for (var x = box.x; x < box.x + box.width; x += step) {
                var offset = (y * width + x) * 4;
                var key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
                bins.set(key, (bins.get(key) || 0) + 1);
                total += 1;
            }
        }
        if (total < 16) return 1;
        var top = Array.from(bins.values()).sort(function (a, b) { return b - a; }).slice(0, 8);
        return top.reduce(function (sum, count) { return sum + count; }, 0) / total;
    }

    function isPhotographic(data, width, box) {
        return dominantShare(data, width, box) < .7;
    }

    // OCR words -> lines. Rows are found by vertical centre, then each row is split where a large horizontal gap
    // separates columns (table cells, badges). Words inside a line are always ordered by x.
    function groupWordsIntoLines(words) {
        var rows = [];
        words.slice().sort(function (a, b) {
            return (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x;
        }).forEach(function (word) {
            var center = word.y + word.height / 2;
            var row = rows.find(function (candidate) {
                return Math.abs(candidate.center - center) <= Math.max(4, Math.min(candidate.height, word.height) * .5);
            });
            if (!row) {
                row = { center: center, height: word.height, words: [] };
                rows.push(row);
            }
            row.words.push(word);
            row.height = Math.min(row.height, word.height);
            row.center = row.words.reduce(function (sum, item) { return sum + item.y + item.height / 2; }, 0) / row.words.length;
        });
        var lines = [];
        rows.forEach(function (row) {
            var ordered = row.words.slice().sort(function (a, b) { return a.x - b.x; });
            var segments = [[ordered[0]]];
            for (var index = 1; index < ordered.length; index += 1) {
                var previous = ordered[index - 1];
                var gap = ordered[index].x - (previous.x + previous.width);
                if (gap > Math.max(24, ordered[index].height * 1.8)) segments.push([]);
                segments[segments.length - 1].push(ordered[index]);
            }
            segments.forEach(function (segment) {
                var x = Math.min.apply(null, segment.map(function (word) { return word.x; }));
                var y = Math.min.apply(null, segment.map(function (word) { return word.y; }));
                var right = Math.max.apply(null, segment.map(function (word) { return word.x + word.width; }));
                var bottom = Math.max.apply(null, segment.map(function (word) { return word.y + word.height; }));
                lines.push({ x: x, y: y, width: right - x, height: bottom - y, words: segment });
            });
        });
        return lines.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    }

    function rowColor(data, width, y, fromX, toX) {
        var reds = [];
        var greens = [];
        var blues = [];
        for (var x = fromX; x < toX; x += 1) {
            var offset = (y * width + x) * 4;
            reds.push(data[offset]);
            greens.push(data[offset + 1]);
            blues.push(data[offset + 2]);
        }
        var mid = function (values) { return values.sort(function (a, b) { return a - b; })[Math.floor(values.length / 2)]; };
        return [mid(reds), mid(greens), mid(blues)];
    }

    function colorGap(first, second) {
        return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
    }

    // Sections: runs of one margin colour (the page edge shows each section's own background), then split at wide empty gaps.
    // Every size is relative to the page width, so tall screenshots behave like short ones.
    function detectBands(data, width, height) {
        var edge = Math.max(3, Math.round(width * .012));
        var runs = [];
        var current = null;
        var pending = 0;
        for (var y = 0; y < height; y += 1) {
            var color = rowColor(data, width, y, 1, 1 + edge);
            if (!current) {
                current = { y: 0, color: color };
                continue;
            }
            if (colorGap(color, current.color) > 14) {
                pending += 1;
                if (pending >= 6) {
                    var start = y - pending + 1;
                    runs.push({ y: current.y, height: start - current.y, color: current.color });
                    current = { y: start, color: color };
                    pending = 0;
                }
            } else {
                pending = 0;
            }
        }
        if (current) runs.push({ y: current.y, height: height - current.y, color: current.color });
        var minGap = Math.max(48, Math.round(width * .058));
        var bands = [];
        runs.forEach(function (run) {
            var empty = 0;
            var emptyStart = run.y;
            var splitAt = [];
            for (var row = run.y; row < run.y + run.height; row += 1) {
                var blank = true;
                for (var x = 0; x < width; x += 3) {
                    var offset = (row * width + x) * 4;
                    if (Math.abs(data[offset] - run.color[0]) + Math.abs(data[offset + 1] - run.color[1]) + Math.abs(data[offset + 2] - run.color[2]) > 12) {
                        blank = false;
                        break;
                    }
                }
                if (blank) {
                    if (!empty) emptyStart = row;
                    empty += 1;
                } else {
                    if (empty >= minGap && emptyStart > run.y) splitAt.push(Math.round(emptyStart + empty / 2));
                    empty = 0;
                }
            }
            var from = run.y;
            splitAt.concat([run.y + run.height]).forEach(function (to) {
                if (to - from > 0) bands.push({ y: from, height: to - from, background: hex(run.color) });
                from = to;
            });
        });
        // Slivers (padding, borders) join a neighbouring band with the same background.
        var sliver = Math.max(24, Math.round(width * .05));
        var sameBackground = function (a, b) {
            return a && b && colorGap([parseInt(a.background.slice(1, 3), 16), parseInt(a.background.slice(3, 5), 16), parseInt(a.background.slice(5, 7), 16)],
                [parseInt(b.background.slice(1, 3), 16), parseInt(b.background.slice(3, 5), 16), parseInt(b.background.slice(5, 7), 16)]) <= 14;
        };
        var merged = [];
        bands.forEach(function (band, index) {
            var previous = merged[merged.length - 1];
            var next = bands[index + 1];
            if (band.height < sliver && previous && sameBackground(previous, band)) {
                previous.height = band.y + band.height - previous.y;
            } else if (previous && previous.height < sliver && sameBackground(previous, band)) {
                previous.height += band.height;
            } else if (band.height < sliver && !previous && next && sameBackground(band, next)) {
                next.y = band.y;
                next.height += band.height;
            } else {
                merged.push({ y: band.y, height: band.height, background: band.background });
            }
        });
        return merged;
    }

    return {
        detectSurfaces: detectSurfaces,
        classifySurfaces: classifySurfaces,
        detectLineRuns: detectLineRuns,
        dominantShare: dominantShare,
        isPhotographic: isPhotographic,
        groupWordsIntoLines: groupWordsIntoLines,
        detectBands: detectBands
    };
}));
