export default function ImageSlot({ src, alt = '', ratio = '4/3', label = '请填写图片', className = '' }) {

  return src ? (

    <img src={src} alt={alt} className={`imgslot-img ${className}`} />

  ) : (

    <div className={`imgslot placeholder ${className}`} style={{ aspectRatio: ratio }}>

      <span>{label}</span>

    </div>

  )

}
